import { cardDedupeKey } from "../card-normalize";
import { l2Normalize } from "../text";
import {
  CHAT_HISTORY_LIMIT,
  rankEmbeddings,
  searchCardsByBm25,
  summarizeEmbeddingModels,
  type CardFtsHit,
  type EmbeddingHit,
  type EmbeddingModelInfo,
  type StoredCapture,
  type StoredCard,
  type StoredChatTurn,
  type StoredChunk,
  type StoredDocument,
  type StoredEmbedding,
  type StoredKaleidoscopeEdge,
  type TuntaStore,
} from "./types";

const DB_NAME = "tunta-local";
const DB_VERSION = 6;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("captures")) {
          const captures = db.createObjectStore("captures", { keyPath: "captureId" });
          captures.createIndex("url", "url", { unique: true });
        }
        if (!db.objectStoreNames.contains("documents")) {
          db.createObjectStore("documents", { keyPath: "sourceId" });
        }
        if (!db.objectStoreNames.contains("cards")) {
          const cards = db.createObjectStore("cards", { keyPath: "cardId" });
          cards.createIndex("sourceId", "sourceId", { unique: false });
        }
        if (!db.objectStoreNames.contains("chat_history")) {
          const history = db.createObjectStore("chat_history", { keyPath: "queryId" });
          history.createIndex("createdAt", "createdAt", { unique: false });
        }
        if (!db.objectStoreNames.contains("kaleidoscope_edges")) {
          db.createObjectStore("kaleidoscope_edges", { keyPath: "edgeId" });
        }
        if (!db.objectStoreNames.contains("embeddings")) {
          // 与 SQL 主键 (owner_kind, owner_id, model) 对齐
          db.createObjectStore("embeddings", { keyPath: ["ownerKind", "ownerId", "model"] });
        }
        if (!db.objectStoreNames.contains("chunks")) {
          const chunks = db.createObjectStore("chunks", { keyPath: "chunkId" });
          chunks.createIndex("sourceId", "sourceId", { unique: false });
        }
        const cards = request.transaction?.objectStore("cards");
        if (cards) {
          const seenCards = new Set<string>();
          let removedCount = 0;
          const cursorRequest = cards.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const card = cursor.value as StoredCard;
            const key = cardDedupeKey(card);
            if (seenCards.has(key)) {
              removedCount += 1;
              cursor.delete();
            } else {
              seenCards.add(key);
            }
            cursor.continue();
          };
          request.transaction?.addEventListener("complete", () => {
            if (removedCount > 0) {
              console.warn(`[tunta] IndexedDB 升级清理了 ${removedCount} 张重复卡片`);
            }
          });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
  }
  return dbPromise;
}

type StoreName = "captures" | "documents" | "cards" | "chat_history" | "kaleidoscope_edges" | "embeddings" | "chunks";

async function withStore<T>(store: StoreName, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = run(tx.objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`IDB ${store} operation failed`));
  });
}

function getAll<T>(store: StoreName): Promise<T[]> {
  const db = openDb();
  return db.then(
    (database) =>
      new Promise<T[]>((resolve, reject) => {
        const tx = database.transaction(store, "readonly");
        const request = tx.objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result as T[]);
        request.onerror = () => reject(request.error ?? new Error(`IDB ${store} getAll failed`));
      }),
  );
}

export class IdbStore implements TuntaStore {
  // captures

  putCapture(capture: StoredCapture): Promise<StoredCapture> {
    return withStore("captures", "readwrite", (s) => s.put(capture)).then(() => capture);
  }

  getCapture(captureId: string): Promise<StoredCapture | undefined> {
    return withStore("captures", "readonly", (s) => s.get(captureId));
  }

  async getCaptureByUrl(url: string): Promise<StoredCapture | undefined> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("captures", "readonly");
      const request = tx.objectStore("captures").index("url").get(url);
      request.onsuccess = () => resolve(request.result as StoredCapture | undefined);
      request.onerror = () => reject(request.error ?? new Error("IDB captures url lookup failed"));
    });
  }

  async listCaptures(): Promise<StoredCapture[]> {
    const all = await getAll<StoredCapture>("captures");
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // documents

  putDocument(doc: StoredDocument): Promise<StoredDocument> {
    return withStore("documents", "readwrite", (s) => s.put(doc)).then(() => doc);
  }

  getDocument(sourceId: string): Promise<StoredDocument | undefined> {
    return withStore("documents", "readonly", (s) => s.get(sourceId));
  }

  listDocuments(): Promise<StoredDocument[]> {
    return getAll<StoredDocument>("documents");
  }

  // cards

  async putCards(cards: StoredCard[]): Promise<void> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("cards", "readwrite");
      const store = tx.objectStore("cards");
      for (const card of cards) store.put(card);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IDB cards bulk put failed"));
    });
  }

  async replaceCardsForSource(sourceId: string, cards: StoredCard[]): Promise<void> {
    if (cards.some((card) => card.sourceId !== sourceId)) {
      throw new Error(`replaceCardsForSource 收到跨 source 卡片：${sourceId}`);
    }
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("cards", "readwrite");
      const store = tx.objectStore("cards");
      const cursorRequest = store.index("sourceId").openKeyCursor(IDBKeyRange.only(sourceId));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
          return;
        }
        for (const card of cards) store.put(card);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IDB cards source replace failed"));
    });
  }

  putCard(card: StoredCard): Promise<StoredCard> {
    return withStore("cards", "readwrite", (s) => s.put(card)).then(() => card);
  }

  async listCards(): Promise<StoredCard[]> {
    return getAll<StoredCard>("cards");
  }

  async listCardsBySource(sourceId: string): Promise<StoredCard[]> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("cards", "readonly");
      const request = tx.objectStore("cards").index("sourceId").getAll(sourceId);
      request.onsuccess = () => resolve(request.result as StoredCard[]);
      request.onerror = () => reject(request.error ?? new Error("IDB cards by source failed"));
    });
  }

  /** 迁移完成前的退路：全量拉卡后跑 JS BM25，与 SqlCore 的 FTS5 路径语义对齐。 */
  async searchCardsFts(query: string, limit: number): Promise<CardFtsHit[]> {
    return searchCardsByBm25(await this.listCards(), query, limit);
  }

  // chunks（计划 §Task2.3）

  async replaceChunksForSource(sourceId: string, chunks: StoredChunk[]): Promise<void> {
    if (chunks.some((chunk) => chunk.sourceId !== sourceId)) {
      throw new Error(`replaceChunksForSource 收到跨 source chunk：${sourceId}`);
    }
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("chunks", "readwrite");
      const store = tx.objectStore("chunks");
      const cursorRequest = store.index("sourceId").openKeyCursor(IDBKeyRange.only(sourceId));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
          return;
        }
        for (const chunk of chunks) store.put(chunk);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IDB chunks source replace failed"));
    });
  }

  async listChunksBySource(sourceId: string): Promise<StoredChunk[]> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("chunks", "readonly");
      const request = tx.objectStore("chunks").index("sourceId").getAll(sourceId);
      request.onsuccess = () => resolve(request.result as StoredChunk[]);
      request.onerror = () => reject(request.error ?? new Error("IDB chunks by source failed"));
    });
  }

  // embeddings（迁移前退路也要持久化：Task2.3 的 embed 去重不能在未迁移用户上失效）

  async putEmbeddings(embeddings: StoredEmbedding[]): Promise<void> {
    if (embeddings.length === 0) return;
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("embeddings", "readwrite");
      const store = tx.objectStore("embeddings");
      // 与 SqlCore 对齐：存的就是归一化后的向量
      for (const item of embeddings) store.put({ ...item, vector: [...l2Normalize(item.vector)] });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IDB embeddings bulk put failed"));
    });
  }

  async searchEmbeddings(queryVector: number[], model: string, topK: number, ownerKind?: StoredEmbedding["ownerKind"]): Promise<EmbeddingHit[]> {
    return rankEmbeddings(await getAll<StoredEmbedding>("embeddings"), queryVector, model, topK, ownerKind);
  }

  async listEmbeddingModels(): Promise<EmbeddingModelInfo[]> {
    return summarizeEmbeddingModels(await getAll<StoredEmbedding>("embeddings"));
  }

  async listEmbeddedOwnerIds(ownerKind: StoredEmbedding["ownerKind"], model: string): Promise<string[]> {
    return (await getAll<StoredEmbedding>("embeddings"))
      .filter((item) => item.ownerKind === ownerKind && item.model === model)
      .map((item) => item.ownerId);
  }

  async deleteEmbeddings(ownerKind: StoredEmbedding["ownerKind"], ownerIds: string[]): Promise<void> {
    if (ownerIds.length === 0) return;
    const ids = new Set(ownerIds);
    const related = (await getAll<StoredEmbedding>("embeddings")).filter(
      (item) => item.ownerKind === ownerKind && ids.has(item.ownerId),
    );
    if (related.length === 0) return;
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("embeddings", "readwrite");
      const store = tx.objectStore("embeddings");
      for (const item of related) store.delete([item.ownerKind, item.ownerId, item.model]);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IDB embeddings delete failed"));
    });
  }

  // history

  putChatTurn(record: StoredChatTurn): Promise<StoredChatTurn> {
    return withStore("chat_history", "readwrite", (s) => s.put(record)).then(() => record);
  }

  getChatTurnRecord(queryId: string): Promise<StoredChatTurn | undefined> {
    return withStore("chat_history", "readonly", (s) => s.get(queryId));
  }

  async listChatTurns(): Promise<StoredChatTurn[]> {
    const all = await getAll<StoredChatTurn>("chat_history");
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async pruneChatTurns(keep = CHAT_HISTORY_LIMIT): Promise<void> {
    const all = await this.listChatTurns();
    const overflow = all.slice(keep);
    if (overflow.length === 0) return;
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("chat_history", "readwrite");
      const store = tx.objectStore("chat_history");
      for (const record of overflow) store.delete(record.queryId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IDB chat_history prune failed"));
    });
  }

  // kaleidoscope edges

  async putKaleidoscopeEdges(edges: StoredKaleidoscopeEdge[]): Promise<void> {
    if (edges.length === 0) return;
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("kaleidoscope_edges", "readwrite");
      const store = tx.objectStore("kaleidoscope_edges");
      for (const edge of edges) store.put(edge);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IDB kaleidoscope_edges bulk put failed"));
    });
  }

  listKaleidoscopeEdges(): Promise<StoredKaleidoscopeEdge[]> {
    return getAll<StoredKaleidoscopeEdge>("kaleidoscope_edges");
  }

  async clearKaleidoscopeEdges(): Promise<void> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("kaleidoscope_edges", "readwrite");
      tx.objectStore("kaleidoscope_edges").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IDB kaleidoscope_edges clear failed"));
    });
  }

  async deleteKaleidoscopeEdgesForSource(sourceId: string): Promise<void> {
    const related = (await this.listKaleidoscopeEdges()).filter(
      (edge) => edge.fromSourceId === sourceId || edge.toSourceId === sourceId,
    );
    if (related.length === 0) return;
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("kaleidoscope_edges", "readwrite");
      const store = tx.objectStore("kaleidoscope_edges");
      for (const edge of related) store.delete(edge.edgeId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IDB kaleidoscope_edges delete failed"));
    });
  }

  async clearAllLocalData(): Promise<void> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["captures", "documents", "cards", "chat_history", "kaleidoscope_edges", "embeddings", "chunks"], "readwrite");
      tx.objectStore("captures").clear();
      tx.objectStore("documents").clear();
      tx.objectStore("cards").clear();
      tx.objectStore("chat_history").clear();
      tx.objectStore("kaleidoscope_edges").clear();
      tx.objectStore("embeddings").clear();
      tx.objectStore("chunks").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IDB clearAll failed"));
    });
  }
}

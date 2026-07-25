import type { CaptureItem, CardType, ChatTurn } from "@/shared/api/contracts";
import type { ParserOutput } from "./parser";


export interface StoredCapture extends CaptureItem {
  stage?: "snapshot" | "cards" | "embed" | "graph";
  curationNote?: string;
  expandLinks?: string[];
  /** 自动续跑次数。仅本地流水线使用，不进入对外 CaptureItem。 */
  attempts?: number;
}

export interface StoredDocument {
  sourceId: string;
  url: string;
  title: string;
  curatedTitle?: string;
  summary?: string;
  platform: string;
  contentHash: string;
  parserOutput: ParserOutput;
  createdAt: string;
}

export interface StoredCard {
  cardId: string;
  sourceId: string;
  cardType: CardType;
  title: string;
  body: string;
  domainLabels: string[];
  evidence: { blockId: string; quote: string | null }[];
  embedding: number[] | null;
  createdAt: string;
}

export interface StoredChatTurn {
  queryId: string;
  query: string;
  createdAt: string;
  turn: ChatTurn;
}



export interface StoredKaleidoscopeEdge {
  edgeId: string;
  fromSourceId: string;
  toSourceId: string;
  relation: string;
  strength: number;
  createdAt: string;
}

const DB_NAME = "tunta-local";
const DB_VERSION = 3;

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
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
  }
  return dbPromise;
}

type StoreName = "captures" | "documents" | "cards" | "chat_history" | "kaleidoscope_edges";

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

// captures

export function putCapture(capture: StoredCapture): Promise<StoredCapture> {
  return withStore("captures", "readwrite", (s) => s.put(capture)).then(() => capture);
}

export function getCapture(captureId: string): Promise<StoredCapture | undefined> {
  return withStore("captures", "readonly", (s) => s.get(captureId));
}

export async function getCaptureByUrl(url: string): Promise<StoredCapture | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("captures", "readonly");
    const request = tx.objectStore("captures").index("url").get(url);
    request.onsuccess = () => resolve(request.result as StoredCapture | undefined);
    request.onerror = () => reject(request.error ?? new Error("IDB captures url lookup failed"));
  });
}

export async function listCaptures(): Promise<StoredCapture[]> {
  const all = await getAll<StoredCapture>("captures");
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// documents

export function putDocument(doc: StoredDocument): Promise<StoredDocument> {
  return withStore("documents", "readwrite", (s) => s.put(doc)).then(() => doc);
}

export function getDocument(sourceId: string): Promise<StoredDocument | undefined> {
  return withStore("documents", "readonly", (s) => s.get(sourceId));
}

export function listDocuments(): Promise<StoredDocument[]> {
  return getAll<StoredDocument>("documents");
}

// cards

export async function putCards(cards: StoredCard[]): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("cards", "readwrite");
    const store = tx.objectStore("cards");
    for (const card of cards) store.put(card);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IDB cards bulk put failed"));
  });
}

export function putCard(card: StoredCard): Promise<StoredCard> {
  return withStore("cards", "readwrite", (s) => s.put(card)).then(() => card);
}

export async function listCards(): Promise<StoredCard[]> {
  return getAll<StoredCard>("cards");
}

export async function listCardsBySource(sourceId: string): Promise<StoredCard[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("cards", "readonly");
    const request = tx.objectStore("cards").index("sourceId").getAll(sourceId);
    request.onsuccess = () => resolve(request.result as StoredCard[]);
    request.onerror = () => reject(request.error ?? new Error("IDB cards by source failed"));
  });
}

// history
const CHAT_HISTORY_LIMIT = 100;

export function putChatTurn(record: StoredChatTurn): Promise<StoredChatTurn> {
  return withStore("chat_history", "readwrite", (s) => s.put(record)).then(() => record);
}

export function getChatTurnRecord(queryId: string): Promise<StoredChatTurn | undefined> {
  return withStore("chat_history", "readonly", (s) => s.get(queryId));
}


export async function listChatTurns(): Promise<StoredChatTurn[]> {
  const all = await getAll<StoredChatTurn>("chat_history");
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function pruneChatTurns(keep = CHAT_HISTORY_LIMIT): Promise<void> {
  const all = await listChatTurns();
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


export function kaleidoscopeEdgeId(a: string, b: string): string {
  return `kedge:${[a, b].sort().join("::")}`;
}

export async function putKaleidoscopeEdges(edges: StoredKaleidoscopeEdge[]): Promise<void> {
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

export function listKaleidoscopeEdges(): Promise<StoredKaleidoscopeEdge[]> {
  return getAll<StoredKaleidoscopeEdge>("kaleidoscope_edges");
}

export async function clearKaleidoscopeEdges(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kaleidoscope_edges", "readwrite");
    tx.objectStore("kaleidoscope_edges").clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IDB kaleidoscope_edges clear failed"));
  });
}

export async function deleteKaleidoscopeEdgesForSource(sourceId: string): Promise<void> {
  const related = (await listKaleidoscopeEdges()).filter(
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

export async function clearAllLocalData(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["captures", "documents", "cards", "chat_history", "kaleidoscope_edges"], "readwrite");
    tx.objectStore("captures").clear();
    tx.objectStore("documents").clear();
    tx.objectStore("cards").clear();
    tx.objectStore("chat_history").clear();
    tx.objectStore("kaleidoscope_edges").clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IDB clearAll failed"));
  });
}

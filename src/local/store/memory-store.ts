import { l2Normalize } from "../text.js";
import {
  CHAT_HISTORY_LIMIT,
  embeddingKey,
  rankEmbeddings,
  searchCardsByBm25,
  summarizeEmbeddingModels,
  syncEntityState,
  type CardFtsHit,
  type EmbeddingHit,
  type EmbeddingModelInfo,
  type StoredCapture,
  type StoredCard,
  type StoredChatTurn,
  type StoredChunk,
  type StoredDocument,
  type StoredEmbedding,
  type StoredEntity,
  type StoredEntityEdge,
  type StoredEdgeExplanation,
  type StoredKaleidoscopeEdge,
  type StoredMention,
  type TuntaStore,
} from "./types.js";

/** 模拟 IndexedDB 的 structuredClone 语义：存取都是副本，不共享引用。 */
function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * 纯内存实现的 TuntaStore。行为对齐 IdbStore（排序、唯一约束、跨 source 报错），
 * 供 Node 环境下的契约测试与 Phase 2/3 的检索、图谱逻辑测试使用。
 */
export class MemoryStore implements TuntaStore {
  private captures = new Map<string, StoredCapture>();
  private documents = new Map<string, StoredDocument>();
  private cards = new Map<string, StoredCard>();
  private chatTurns = new Map<string, StoredChatTurn>();
  private kaleidoscopeEdges = new Map<string, StoredKaleidoscopeEdge>();
  private embeddings = new Map<string, StoredEmbedding>();
  private chunks = new Map<string, StoredChunk>();
  private entities = new Map<string, StoredEntity>();
  private mentions: StoredMention[] = [];
  private entityEdges: StoredEntityEdge[] = [];
    private edgeExplanations = new Map<string, StoredEdgeExplanation>();

  // captures

  async putCapture(capture: StoredCapture): Promise<StoredCapture> {
    // 对齐 IdbStore 的 url 唯一索引：不同 captureId 撞同一 url 时抛错
    for (const existing of this.captures.values()) {
      if (existing.url === capture.url && existing.captureId !== capture.captureId) {
        throw new Error(`captures url 唯一约束冲突：${capture.url}`);
      }
    }
    this.captures.set(capture.captureId, clone(capture));
    return capture;
  }

  async getCapture(captureId: string): Promise<StoredCapture | undefined> {
    const found = this.captures.get(captureId);
    return found ? clone(found) : undefined;
  }

  async getCaptureByUrl(url: string): Promise<StoredCapture | undefined> {
    for (const capture of this.captures.values()) {
      if (capture.url === url) return clone(capture);
    }
    return undefined;
  }

  async listCaptures(): Promise<StoredCapture[]> {
    return [...this.captures.values()].map(clone).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // documents

  async putDocument(doc: StoredDocument): Promise<StoredDocument> {
    this.documents.set(doc.sourceId, clone(doc));
    return doc;
  }

  async getDocument(sourceId: string): Promise<StoredDocument | undefined> {
    const found = this.documents.get(sourceId);
    return found ? clone(found) : undefined;
  }

  async listDocuments(): Promise<StoredDocument[]> {
    return [...this.documents.values()].map(clone);
  }

  // cards

  async putCards(cards: StoredCard[]): Promise<void> {
    for (const card of cards) this.cards.set(card.cardId, clone(card));
  }

  async replaceCardsForSource(sourceId: string, cards: StoredCard[]): Promise<void> {
    if (cards.some((card) => card.sourceId !== sourceId)) {
      throw new Error(`replaceCardsForSource 收到跨 source 卡片：${sourceId}`);
    }
    for (const [cardId, card] of this.cards) {
      if (card.sourceId === sourceId) this.cards.delete(cardId);
    }
    for (const card of cards) this.cards.set(card.cardId, clone(card));
  }

  async putCard(card: StoredCard): Promise<StoredCard> {
    this.cards.set(card.cardId, clone(card));
    return card;
  }

  async listCards(): Promise<StoredCard[]> {
    return [...this.cards.values()].map(clone);
  }

  async listCardsBySource(sourceId: string): Promise<StoredCard[]> {
    return [...this.cards.values()].filter((card) => card.sourceId === sourceId).map(clone);
  }

  async searchCardsFts(query: string, limit: number): Promise<CardFtsHit[]> {
    return searchCardsByBm25([...this.cards.values()], query, limit);
  }

  // chunks

  async replaceChunksForSource(sourceId: string, chunks: StoredChunk[]): Promise<void> {
    if (chunks.some((chunk) => chunk.sourceId !== sourceId)) {
      throw new Error(`replaceChunksForSource 收到跨 source chunk：${sourceId}`);
    }
    for (const [chunkId, chunk] of this.chunks) {
      if (chunk.sourceId === sourceId) this.chunks.delete(chunkId);
    }
    for (const chunk of chunks) this.chunks.set(chunk.chunkId, clone(chunk));
  }

  async listChunksBySource(sourceId: string): Promise<StoredChunk[]> {
    return [...this.chunks.values()].filter((chunk) => chunk.sourceId === sourceId).map(clone);
  }

  // embeddings

  async putEmbeddings(embeddings: StoredEmbedding[]): Promise<void> {
    for (const item of embeddings) {
      // 与 SqlCore 对齐：存的就是归一化后的向量
      this.embeddings.set(embeddingKey(item.ownerKind, item.ownerId, item.model), {
        ...clone(item),
        vector: [...l2Normalize(item.vector)],
      });
    }
  }

  async searchEmbeddings(queryVector: number[], model: string, topK: number, ownerKind?: StoredEmbedding["ownerKind"]): Promise<EmbeddingHit[]> {
    return rankEmbeddings([...this.embeddings.values()], queryVector, model, topK, ownerKind);
  }

  async listEmbeddingModels(): Promise<EmbeddingModelInfo[]> {
    return summarizeEmbeddingModels([...this.embeddings.values()]);
  }

  async listEmbeddedOwnerIds(ownerKind: StoredEmbedding["ownerKind"], model: string): Promise<string[]> {
    return [...this.embeddings.values()]
      .filter((item) => item.ownerKind === ownerKind && item.model === model)
      .map((item) => item.ownerId);
  }

  async deleteEmbeddings(ownerKind: StoredEmbedding["ownerKind"], ownerIds: string[]): Promise<void> {
    const ids = new Set(ownerIds);
    for (const [key, item] of this.embeddings) {
      if (item.ownerKind === ownerKind && ids.has(item.ownerId)) this.embeddings.delete(key);
    }
  }

  // history

  async putChatTurn(record: StoredChatTurn): Promise<StoredChatTurn> {
    this.chatTurns.set(record.queryId, clone(record));
    return record;
  }

  async getChatTurnRecord(queryId: string): Promise<StoredChatTurn | undefined> {
    const found = this.chatTurns.get(queryId);
    return found ? clone(found) : undefined;
  }

  async listChatTurns(): Promise<StoredChatTurn[]> {
    return [...this.chatTurns.values()].map(clone).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async pruneChatTurns(keep = CHAT_HISTORY_LIMIT): Promise<void> {
    const all = await this.listChatTurns();
    for (const record of all.slice(keep)) {
      this.chatTurns.delete(record.queryId);
    }
  }

  // entities / mentions（计划 §Task3.2）

  async syncEntityMentionsForSource(sourceId: string, cards: StoredCard[]): Promise<void> {
    const next = syncEntityState([...this.entities.values()], this.mentions, sourceId, cards, new Date().toISOString());
    this.entities = new Map(next.entities.map((entity) => [entity.entityId, clone(entity)]));
    this.mentions = next.mentions.map(clone);
  }

  async listEntities(): Promise<StoredEntity[]> {
    return [...this.entities.values()].map(clone).sort((a, b) => a.entityId.localeCompare(b.entityId));
  }

  async listMentions(): Promise<StoredMention[]> {
    return this.mentions
      .map(clone)
      .sort((a, b) => a.entityId.localeCompare(b.entityId) || a.cardId.localeCompare(b.cardId));
  }

  // entity edges（计划 §Task3.3）

  async setHubEntities(entityIds: string[]): Promise<void> {
    const hubs = new Set(entityIds);
    for (const [entityId, entity] of this.entities) {
      this.entities.set(entityId, { ...entity, isHub: hubs.has(entityId) });
    }
  }

  async replaceEntityEdges(edges: StoredEntityEdge[]): Promise<void> {
    this.entityEdges = edges.map(clone);
  }

  async listEntityEdges(): Promise<StoredEntityEdge[]> {
    return this.entityEdges.map(clone).sort((a, b) => a.aId.localeCompare(b.aId) || a.bId.localeCompare(b.bId));
  }

  // kaleidoscope edges

  async putKaleidoscopeEdges(edges: StoredKaleidoscopeEdge[]): Promise<void> {
    for (const edge of edges) this.kaleidoscopeEdges.set(edge.edgeId, clone(edge));
  }

  async listKaleidoscopeEdges(): Promise<StoredKaleidoscopeEdge[]> {
    return [...this.kaleidoscopeEdges.values()].map(clone);
  }

  async clearKaleidoscopeEdges(): Promise<void> {
    this.kaleidoscopeEdges.clear();
  }

  async deleteKaleidoscopeEdgesForSource(sourceId: string): Promise<void> {
    for (const [edgeId, edge] of this.kaleidoscopeEdges) {
      if (edge.fromSourceId === sourceId || edge.toSourceId === sourceId) {
        this.kaleidoscopeEdges.delete(edgeId);
      }
    }
  }

  // edge explanations（计划 §Task3.5）

  async getEdgeExplanation(edgeId: string): Promise<StoredEdgeExplanation | undefined> {
    const found = this.edgeExplanations.get(edgeId);
    return found ? clone(found) : undefined;
  }

  async putEdgeExplanation(record: StoredEdgeExplanation): Promise<StoredEdgeExplanation> {
    this.edgeExplanations.set(record.edgeId, clone(record));
    return record;
  }

  async clearAllLocalData(): Promise<void> {
    this.captures.clear();
    this.documents.clear();
    this.cards.clear();
    this.chatTurns.clear();
    this.kaleidoscopeEdges.clear();
    this.embeddings.clear();
    this.chunks.clear();
    this.entities.clear();
    this.mentions = [];
    this.entityEdges = [];
    this.edgeExplanations.clear();
  }
}

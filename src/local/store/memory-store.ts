import {
  CHAT_HISTORY_LIMIT,
  type StoredCapture,
  type StoredCard,
  type StoredChatTurn,
  type StoredDocument,
  type StoredKaleidoscopeEdge,
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

  async clearAllLocalData(): Promise<void> {
    this.captures.clear();
    this.documents.clear();
    this.cards.clear();
    this.chatTurns.clear();
    this.kaleidoscopeEdges.clear();
  }
}

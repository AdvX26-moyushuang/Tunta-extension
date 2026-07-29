import type { CaptureItem, CardType, ChatTurn } from "@/shared/api/contracts";
import { bm25Rank, tokenize } from "../text.js";
import type { ParserOutput } from "../parser";

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

export const CHAT_HISTORY_LIMIT = 100;

/** searchCardsFts 的命中项：分高者在前，score 恒为正（FTS5 的 bm25() 取反号）。 */
export interface CardFtsHit {
  cardId: string;
  score: number;
}

/** 卡片进 FTS 索引的文本（计划 §Task2.1）：写入与查询两侧必须用同一个拼接。 */
export function cardFtsText(card: Pick<StoredCard, "title" | "body" | "domainLabels">): string {
  return `${card.title}\n${card.body}\n${card.domainLabels.join(" ")}`;
}

/** MemoryStore / IdbStore 的 searchCardsFts 共用实现：JS BM25，与 FTS5 路径语义对齐。 */
export function searchCardsByBm25(cards: StoredCard[], query: string, limit: number): CardFtsHit[] {
  const hits = bm25Rank(
    tokenize(query),
    cards.map((card) => ({ id: card.cardId, tokens: tokenize(cardFtsText(card)) })),
  );
  return hits.slice(0, limit).map((hit) => ({ cardId: hit.id, score: hit.score }));
}

/** 纯函数，不依赖存储实现，各实现共用。 */
export function kaleidoscopeEdgeId(a: string, b: string): string {
  return `kedge:${[a, b].sort().join("::")}`;
}

/**
 * 存储访问的唯一入口。业务层只依赖这个接口，不碰任何存储实现。
 * 方法签名与原 db.ts 的导出函数一一对应。
 */
export interface TuntaStore {
  // captures
  putCapture(capture: StoredCapture): Promise<StoredCapture>;
  getCapture(captureId: string): Promise<StoredCapture | undefined>;
  getCaptureByUrl(url: string): Promise<StoredCapture | undefined>;
  listCaptures(): Promise<StoredCapture[]>;

  // documents
  putDocument(doc: StoredDocument): Promise<StoredDocument>;
  getDocument(sourceId: string): Promise<StoredDocument | undefined>;
  listDocuments(): Promise<StoredDocument[]>;

  // cards
  putCards(cards: StoredCard[]): Promise<void>;
  replaceCardsForSource(sourceId: string, cards: StoredCard[]): Promise<void>;
  putCard(card: StoredCard): Promise<StoredCard>;
  listCards(): Promise<StoredCard[]>;
  listCardsBySource(sourceId: string): Promise<StoredCard[]>;
  /** FTS 检索（计划 §Task2.1）：SQL 实现走 FTS5 bm25，其余实现走等价 JS BM25。 */
  searchCardsFts(query: string, limit: number): Promise<CardFtsHit[]>;

  // chat history
  putChatTurn(record: StoredChatTurn): Promise<StoredChatTurn>;
  getChatTurnRecord(queryId: string): Promise<StoredChatTurn | undefined>;
  listChatTurns(): Promise<StoredChatTurn[]>;
  pruneChatTurns(keep?: number): Promise<void>;

  // kaleidoscope edges
  putKaleidoscopeEdges(edges: StoredKaleidoscopeEdge[]): Promise<void>;
  listKaleidoscopeEdges(): Promise<StoredKaleidoscopeEdge[]>;
  clearKaleidoscopeEdges(): Promise<void>;
  deleteKaleidoscopeEdgesForSource(sourceId: string): Promise<void>;

  // maintenance
  clearAllLocalData(): Promise<void>;
}

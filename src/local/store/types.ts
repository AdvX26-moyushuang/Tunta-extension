import type { CaptureItem, CardType, ChatTurn } from "@/shared/api/contracts";
import { bm25Rank, dotProduct, l2Normalize, tokenize } from "../text.js";
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
  /** 策展时随卡抽取的实体（计划 §Task3.1）；存量卡片缺失此字段，消费方用 ?? []。 */
  entities?: CardEntity[];
  embedding: number[] | null;
  createdAt: string;
}

// ---- 实体（计划 §Task3.1） ----

/** 实体类型限死六个值，越界的在抽取清洗阶段丢弃。 */
export const ENTITY_TYPES = ["person", "concept", "tool", "method", "work", "org"] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export interface CardEntity {
  name: string;
  type: EntityType;
}

// ---- 实体表与消歧（计划 §Task3.2） ----

/** canonicalId 非空 = 已被软合并进另一个实体；消歧候选与合并 UI 属后续任务。 */
export interface StoredEntity {
  entityId: string;
  name: string;
  type: EntityType;
  canonicalId: string | null;
  mentionCount: number;
  /** hub = 出现在超过 30% 卡片的泛化实体（计划 §Task3.3）：从图剔除但保留为标签。 */
  isHub: boolean;
  createdAt: string;
}

/** 同时存 cardId 和 blockId 是图谱结构成立的关键：实体到原文一跳可达。 */
export interface StoredMention {
  entityId: string;
  cardId: string;
  blockId: string | null;
  sourceId: string;
}

/** 确定性实体 ID：唯一约束 lower(name)+type 正好就是 ID 本体，PK 冲突 == 唯一约束冲突。 */
export function stableEntityId(name: string, type: EntityType): string {
  return `entity:${type}:${name.toLowerCase()}`;
}

/** 一个 source 的卡片 → 去重实体 + mentions。blockId 指向卡片第一条证据。 */
export function entityMentionsFromCards(
  sourceId: string,
  cards: StoredCard[],
): { entities: { entityId: string; name: string; type: EntityType }[]; mentions: StoredMention[] } {
  if (cards.some((card) => card.sourceId !== sourceId)) {
    throw new Error(`syncEntityMentionsForSource 收到跨 source 卡片：${sourceId}`);
  }
  const entities = new Map<string, { entityId: string; name: string; type: EntityType }>();
  const mentions: StoredMention[] = [];
  for (const card of cards) {
    const seen = new Set<string>();
    for (const entity of card.entities ?? []) {
      const entityId = stableEntityId(entity.name, entity.type);
      // 首见大小写胜出，与 SQL 的 ON CONFLICT DO NOTHING 语义对齐
      if (!entities.has(entityId)) entities.set(entityId, { entityId, name: entity.name, type: entity.type });
      if (seen.has(entityId)) continue;
      seen.add(entityId);
      mentions.push({ entityId, cardId: card.cardId, blockId: card.evidence[0]?.blockId ?? null, sourceId });
    }
  }
  return { entities: [...entities.values()], mentions };
}

/**
 * MemoryStore / IdbStore 的 syncEntityMentionsForSource 共用实现：
 * upsert 实体（已存在的保持首见 name / createdAt / canonicalId）、
 * 删本 source 旧 mentions、插新、mention_count 全量重算（小库不做增量记账）。
 */
export function syncEntityState(
  entities: StoredEntity[],
  mentions: StoredMention[],
  sourceId: string,
  cards: StoredCard[],
  now: string,
): { entities: StoredEntity[]; mentions: StoredMention[] } {
  const incoming = entityMentionsFromCards(sourceId, cards);
  const byId = new Map(entities.map((entity) => [entity.entityId, entity]));
  for (const entity of incoming.entities) {
    if (!byId.has(entity.entityId)) {
      byId.set(entity.entityId, { ...entity, canonicalId: null, mentionCount: 0, isHub: false, createdAt: now });
    }
  }
  const nextMentions = [...mentions.filter((mention) => mention.sourceId !== sourceId), ...incoming.mentions];
  const counts = new Map<string, number>();
  for (const mention of nextMentions) counts.set(mention.entityId, (counts.get(mention.entityId) ?? 0) + 1);
  const nextEntities = [...byId.values()].map((entity) => ({
    ...entity,
    mentionCount: counts.get(entity.entityId) ?? 0,
  }));
  return { entities: nextEntities, mentions: nextMentions };
}

// ---- 共现边（计划 §Task3.3）：纯计算，零 LLM ----

/** 实体共现边，约定 aId < bId。派生数据：每次重建全量重写。 */
export interface StoredEntityEdge {
  aId: string;
  bId: string;
  cooccurCount: number;
  pmi: number | null;
}

/** hub 判定阈值：出现在超过 30% 卡片的实体降级。 */
export const HUB_CARD_RATIO = 0.3;
/** 小库不降级：卡片太少时任何实体都容易越过比例线，图反而被清空。 */
export const HUB_MIN_CARDS = 10;

/**
 * 实体共现图（计划 §Task3.3）：两实体同卡 → cooccur_count+1，PMI 重建时全量重算。
 * hub 实体不参与建边（否则图退化成星型）。mentions 主键 (entityId, cardId)
 * 保证每实体每卡至多一条 mention，实体的 mentionCount == 覆盖卡片数。
 */
export function computeEntityGraph(
  mentions: StoredMention[],
  totalCards: number,
): { hubIds: string[]; edges: StoredEntityEdge[] } {
  const cardCounts = new Map<string, number>();
  for (const mention of mentions) {
    cardCounts.set(mention.entityId, (cardCounts.get(mention.entityId) ?? 0) + 1);
  }
  const hubs = new Set<string>();
  if (totalCards >= HUB_MIN_CARDS) {
    for (const [entityId, count] of cardCounts) {
      if (count > totalCards * HUB_CARD_RATIO) hubs.add(entityId);
    }
  }
  const byCard = new Map<string, string[]>();
  for (const mention of mentions) {
    if (hubs.has(mention.entityId)) continue;
    const list = byCard.get(mention.cardId) ?? [];
    list.push(mention.entityId);
    byCard.set(mention.cardId, list);
  }
  const cooccur = new Map<string, number>();
  for (const list of byCard.values()) {
    const sorted = [...list].sort();
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const key = `${sorted[i]}\u0000${sorted[j]}`;
        cooccur.set(key, (cooccur.get(key) ?? 0) + 1);
      }
    }
  }
  const edges: StoredEntityEdge[] = [...cooccur.entries()].map(([key, count]) => {
    const [aId, bId] = key.split("\u0000") as [string, string];
    // PMI = log(P(a,b) / (P(a)P(b)))，单位事件是「一张卡」
    const pa = cardCounts.get(aId)!;
    const pb = cardCounts.get(bId)!;
    const pmi = totalCards > 0 ? Math.log((count * totalCards) / (pa * pb)) : null;
    return { aId, bId, cooccurCount: count, pmi };
  });
  edges.sort((a, b) => a.aId.localeCompare(b.aId) || a.bId.localeCompare(b.bId));
  return { hubIds: [...hubs].sort(), edges };
}

/**
 * 来源关系边从共享实体派生（计划 §Task3.3 的「来源关系改查询」）：
 * 两个 source 共享 ≥1 个非 hub 实体即建边，relation 列出共享实体名，
 * 替代原来每次收藏一次 LLM 调用的 linkSourceIntoGraph。
 */
export function deriveSourceEdges(
  entities: Pick<StoredEntity, "entityId" | "name">[],
  mentions: StoredMention[],
  hubIds: string[],
  now: string,
): StoredKaleidoscopeEdge[] {
  const hubs = new Set(hubIds);
  const names = new Map(entities.map((entity) => [entity.entityId, entity.name]));
  const sourcesByEntity = new Map<string, Set<string>>();
  for (const mention of mentions) {
    if (hubs.has(mention.entityId)) continue;
    const set = sourcesByEntity.get(mention.entityId) ?? new Set<string>();
    set.add(mention.sourceId);
    sourcesByEntity.set(mention.entityId, set);
  }
  const shared = new Map<string, { a: string; b: string; entityNames: string[] }>();
  for (const [entityId, sources] of sourcesByEntity) {
    const sorted = [...sources].sort();
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const key = `${sorted[i]}\u0000${sorted[j]}`;
        const entry = shared.get(key) ?? { a: sorted[i]!, b: sorted[j]!, entityNames: [] };
        entry.entityNames.push(names.get(entityId) ?? entityId);
        shared.set(key, entry);
      }
    }
  }
  return [...shared.values()]
    .map(({ a, b, entityNames }) => ({
      edgeId: kaleidoscopeEdgeId(a, b),
      fromSourceId: a,
      toSourceId: b,
      relation: `共同涉及：${entityNames.slice(0, 3).join("、")}`,
      strength: Math.min(1, entityNames.length / 3),
      createdAt: now,
    }))
    .sort((a, b) => a.edgeId.localeCompare(b.edgeId));
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

// ---- chunks（计划 §Task2.3） ----

/** 原文聚合块的持久化形态：embeddings 表只存 chunkId 引用，检索命中时回这里取正文与 blockIds。 */
export interface StoredChunk {
  chunkId: string;
  sourceId: string;
  text: string;
  blockIds: string[];
  createdAt: string;
}

// ---- embeddings（计划 §Task2.2） ----

/**
 * 向量的归属方：card = 卡片整体，chunk = 原文聚合块（Task2.3 接入）。
 * RPC/JSON 边界用 number[]，SQL 层内部才转 Float32Array → BLOB。
 */
export interface StoredEmbedding {
  ownerKind: "card" | "chunk";
  ownerId: string;
  model: string;
  vector: number[];
  createdAt: string;
}

export interface EmbeddingHit {
  ownerKind: StoredEmbedding["ownerKind"];
  ownerId: string;
  score: number;
}

/** 换模型后用来查出旧向量提示重建，不静默丢弃。 */
export interface EmbeddingModelInfo {
  model: string;
  dim: number;
  count: number;
}

/**
 * MemoryStore / IdbStore 的 searchEmbeddings 共用实现。
 * 约定 stored 里的向量已在 putEmbeddings 时归一化，这里只归一化查询向量。
 * 只比对 model 相同且维度匹配的向量，与 SqlCore 的 SQL 路径语义对齐。
 */
export function rankEmbeddings(
  stored: StoredEmbedding[],
  queryVector: number[],
  model: string,
  topK: number,
  ownerKind?: StoredEmbedding["ownerKind"],
): EmbeddingHit[] {
  const query = l2Normalize(queryVector);
  const hits: EmbeddingHit[] = [];
  for (const item of stored) {
    if (item.model !== model || item.vector.length !== queryVector.length) continue;
    if (ownerKind !== undefined && item.ownerKind !== ownerKind) continue;
    hits.push({ ownerKind: item.ownerKind, ownerId: item.ownerId, score: dotProduct(query, item.vector) });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, topK);
}

export function embeddingKey(ownerKind: string, ownerId: string, model: string): string {
  return `${ownerKind}::${ownerId}::${model}`;
}

/** MemoryStore / IdbStore 的 listEmbeddingModels 共用实现：按 (model, dim) 分组盘点。 */
export function summarizeEmbeddingModels(stored: StoredEmbedding[]): EmbeddingModelInfo[] {
  const groups = new Map<string, EmbeddingModelInfo>();
  for (const item of stored) {
    const key = `${item.model}::${item.vector.length}`;
    const info = groups.get(key) ?? { model: item.model, dim: item.vector.length, count: 0 };
    info.count += 1;
    groups.set(key, info);
  }
  return [...groups.values()].sort((a, b) => a.model.localeCompare(b.model) || a.dim - b.dim);
}

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

  // chunks（计划 §Task2.3）
  replaceChunksForSource(sourceId: string, chunks: StoredChunk[]): Promise<void>;
  listChunksBySource(sourceId: string): Promise<StoredChunk[]>;

  // embeddings（计划 §Task2.2）
  /** 写入前统一 L2 归一化；同 (ownerKind, ownerId, model) 覆盖更新。 */
  putEmbeddings(embeddings: StoredEmbedding[]): Promise<void>;
  /** 向量检索下沉到 store：避免每次查询把全部向量搬过 RPC。只比对同 model 同维度。 */
  searchEmbeddings(queryVector: number[], model: string, topK: number, ownerKind?: StoredEmbedding["ownerKind"]): Promise<EmbeddingHit[]>;
  listEmbeddingModels(): Promise<EmbeddingModelInfo[]>;
  /** embed 去重用（计划 §Task2.3 禁止重复 embed）：该 model 下已有向量的 owner id 全集。 */
  listEmbeddedOwnerIds(ownerKind: StoredEmbedding["ownerKind"], model: string): Promise<string[]>;
  deleteEmbeddings(ownerKind: StoredEmbedding["ownerKind"], ownerIds: string[]): Promise<void>;

  // chat history
  putChatTurn(record: StoredChatTurn): Promise<StoredChatTurn>;
  getChatTurnRecord(queryId: string): Promise<StoredChatTurn | undefined>;
  listChatTurns(): Promise<StoredChatTurn[]>;
  pruneChatTurns(keep?: number): Promise<void>;

  // entities / mentions（计划 §Task3.2）
  /** 策展落卡后调用：与 replaceCardsForSource 同一批卡片，保证 mentions 与新卡对齐。 */
  syncEntityMentionsForSource(sourceId: string, cards: StoredCard[]): Promise<void>;
  listEntities(): Promise<StoredEntity[]>;
  /** 全量返回：n 小，Task3.3 的共现边直接在内存里算。 */
  listMentions(): Promise<StoredMention[]>;

  // entity edges（计划 §Task3.3）
  /** hub 全量重置：入参内标 1，其余清 0。每次图谱重建时调用。 */
  setHubEntities(entityIds: string[]): Promise<void>;
  /** 派生数据全量重写，不做增量。 */
  replaceEntityEdges(edges: StoredEntityEdge[]): Promise<void>;
  listEntityEdges(): Promise<StoredEntityEdge[]>;

  // kaleidoscope edges
  putKaleidoscopeEdges(edges: StoredKaleidoscopeEdge[]): Promise<void>;
  listKaleidoscopeEdges(): Promise<StoredKaleidoscopeEdge[]>;
  clearKaleidoscopeEdges(): Promise<void>;
  deleteKaleidoscopeEdgesForSource(sourceId: string): Promise<void>;

  // maintenance
  clearAllLocalData(): Promise<void>;
}

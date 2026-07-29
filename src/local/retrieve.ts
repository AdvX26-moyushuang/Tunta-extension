import type { MatchedBy } from "@/shared/api/contracts";
import type { CardFtsHit, StoredCard, StoredChunk } from "./store/types";
import { dotProduct, l2Normalize } from "./text.js";

/**
 * 检索命中的联合形态（计划 §Task2.3）：card 是已过质量判断的提炼结果，
 * chunk 是「AI 没提炼但原文有」的兜底，层级差体现在排序上（同分卡片优先）。
 */
export type RetrieveHit =
  | { kind: "card"; card: StoredCard; score: number; matchedBy: MatchedBy[] }
  | { kind: "chunk"; chunk: StoredChunk; score: number; matchedBy: MatchedBy[] };

/** chunk 向量命中：api 层查 embeddings 表拿排名后回 chunks 表取正文再传入。 */
export interface ChunkVectorHit {
  chunk: StoredChunk;
  score: number;
}

const RRF_K = 60;

/** FTS 候选池大小：RRF 只吃前排名，50 条足够覆盖 topK ≤ 8 的合并窗口。 */
export const FTS_CANDIDATES = 50;

/** chunk 向量候选池：同理，20 条覆盖合并窗口即可。 */
export const CHUNK_VECTOR_CANDIDATES = 20;

/** 向量相似度地板：低于它视为噪声不进 RRF（沿用 Task2.2 之前的 0.05 阈值）。 */
const VECTOR_SCORE_FLOOR = 0.05;

function hitKey(hit: RetrieveHit): string {
  return hit.kind === "card" ? `card::${hit.card.cardId}` : `chunk::${hit.chunk.chunkId}`;
}

/** 同分时卡片优先于 chunk：卡片是已提炼的，chunk 只是原文兜底。 */
function kindPriority(hit: RetrieveHit): number {
  return hit.kind === "card" ? 0 : 1;
}

/**
 * RRF 合并两路召回。FTS 那路已下沉到 store（SQLite FTS5 bm25 / JS BM25 退路），
 * 调用方用 store.searchCardsFts(query, FTS_CANDIDATES) 拿 ftsHits 传入。
 * card 向量暂仍读 card.embedding（存量数据还没回填 embeddings 表）；chunk 向量
 * 来自 embeddings 表，同 model 的余弦分数可与 card 侧直接混成一路排名。
 */
export function retrieveHits(
  cards: StoredCard[],
  ftsHits: CardFtsHit[],
  chunkHits: ChunkVectorHit[],
  topK: number,
  queryEmbedding: number[] | null,
): RetrieveHit[] {
  const cardById = new Map(cards.map((card) => [card.cardId, card]));

  // 两侧归一化后点积，数值等价旧 cosineSimilarity（计划 §Task2.2）。
  const normalizedQuery = queryEmbedding && queryEmbedding.length > 0 ? l2Normalize(queryEmbedding) : null;
  const vectorRanked: { base: RetrieveHit; score: number }[] = [];
  if (normalizedQuery) {
    for (const card of cards) {
      if (!Array.isArray(card.embedding) || card.embedding.length !== normalizedQuery.length) continue;
      const score = dotProduct(normalizedQuery, l2Normalize(card.embedding));
      if (score > VECTOR_SCORE_FLOOR) vectorRanked.push({ base: { kind: "card", card, score: 0, matchedBy: [] }, score });
    }
  }
  for (const { chunk, score } of chunkHits) {
    if (score > VECTOR_SCORE_FLOOR) vectorRanked.push({ base: { kind: "chunk", chunk, score: 0, matchedBy: [] }, score });
  }
  vectorRanked.sort((a, b) => b.score - a.score);

  const merged = new Map<string, RetrieveHit>();
  const accumulate = (base: RetrieveHit, rank: number, channel: MatchedBy) => {
    const key = hitKey(base);
    const existing = merged.get(key) ?? base;
    existing.score += 1 / (RRF_K + rank + 1);
    if (!existing.matchedBy.includes(channel)) existing.matchedBy.push(channel);
    merged.set(key, existing);
  };
  ftsHits.forEach((hit, rank) => {
    const card = cardById.get(hit.cardId);
    if (!card) return; // 防御：FTS 索引与卡片列表瞬时不一致
    accumulate({ kind: "card", card, score: 0, matchedBy: [] }, rank, "fts");
  });
  vectorRanked.forEach((entry, rank) => accumulate(entry.base, rank, "vector"));

  return [...merged.values()]
    .sort((a, b) => b.score - a.score || kindPriority(a) - kindPriority(b))
    .slice(0, topK)
    .map((hit) => ({ ...hit, score: Number(hit.score.toFixed(4)) }));
}

import type { MatchedBy } from "@/shared/api/contracts";
import type { CardFtsHit, StoredCard } from "./store/types";
import { cosineSimilarity } from "./text";

export interface ScoredCard {
  card: StoredCard;
  score: number;
  matchedBy: MatchedBy[];
}

const RRF_K = 60;

/** FTS 候选池大小：RRF 只吃前排名，50 条足够覆盖 topK ≤ 8 的合并窗口。 */
export const FTS_CANDIDATES = 50;

/**
 * RRF 合并两路召回。FTS 那路已下沉到 store（SQLite FTS5 bm25 / JS BM25 退路），
 * 调用方用 store.searchCardsFts(query, FTS_CANDIDATES) 拿 ftsHits 传入。
 */
export function retrieveCards(cards: StoredCard[], ftsHits: CardFtsHit[], topK: number, queryEmbedding: number[] | null): ScoredCard[] {
  const cardById = new Map(cards.map((card) => [card.cardId, card]));

  const vectorRanked =
    queryEmbedding && queryEmbedding.length > 0
      ? cards
          .filter((card) => Array.isArray(card.embedding) && card.embedding.length === queryEmbedding.length)
          .map((card) => ({ card, score: cosineSimilarity(queryEmbedding, card.embedding as number[]) }))
          .filter((entry) => entry.score > 0.05)
          .sort((a, b) => b.score - a.score)
      : [];

  const merged = new Map<string, ScoredCard>();
  ftsHits.forEach((hit, rank) => {
    const card = cardById.get(hit.cardId);
    if (!card) return; // 防御：FTS 索引与卡片列表瞬时不一致
    const existing = merged.get(card.cardId) ?? { card, score: 0, matchedBy: [] };
    existing.score += 1 / (RRF_K + rank + 1);
    if (!existing.matchedBy.includes("fts")) existing.matchedBy.push("fts");
    merged.set(card.cardId, existing);
  });
  vectorRanked.forEach((entry, rank) => {
    const existing = merged.get(entry.card.cardId) ?? { card: entry.card, score: 0, matchedBy: [] };
    existing.score += 1 / (RRF_K + rank + 1);
    if (!existing.matchedBy.includes("vector")) existing.matchedBy.push("vector");
    merged.set(entry.card.cardId, existing);
  });

  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((entry) => ({ ...entry, score: Number(entry.score.toFixed(4)) }));
}

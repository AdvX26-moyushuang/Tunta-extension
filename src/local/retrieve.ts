import type { MatchedBy } from "@/shared/api/contracts";
import type { StoredCard } from "./db";
import { cosineSimilarity, ftsScore, termFrequencies, tokenize } from "./text";

export interface ScoredCard {
  card: StoredCard;
  score: number;
  matchedBy: MatchedBy[];
}

const RRF_K = 60;

export function retrieveCards(cards: StoredCard[], query: string, topK: number, queryEmbedding: number[] | null): ScoredCard[] {
  const queryTokens = tokenize(query);

  const ftsRanked = cards
    .map((card) => {
      const tf = termFrequencies(tokenize(`${card.title}\n${card.body}\n${card.domainLabels.join(" ")}`));
      return { card, score: ftsScore(queryTokens, tf) };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const vectorRanked =
    queryEmbedding && queryEmbedding.length > 0
      ? cards
          .filter((card) => Array.isArray(card.embedding) && card.embedding.length === queryEmbedding.length)
          .map((card) => ({ card, score: cosineSimilarity(queryEmbedding, card.embedding as number[]) }))
          .filter((entry) => entry.score > 0.05)
          .sort((a, b) => b.score - a.score)
      : [];

  const merged = new Map<string, ScoredCard>();
  ftsRanked.forEach((entry, rank) => {
    const existing = merged.get(entry.card.cardId) ?? { card: entry.card, score: 0, matchedBy: [] };
    existing.score += 1 / (RRF_K + rank + 1);
    if (!existing.matchedBy.includes("fts")) existing.matchedBy.push("fts");
    merged.set(entry.card.cardId, existing);
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

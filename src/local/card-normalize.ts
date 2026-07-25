import type { StoredCard } from "./db";

export type CardWithoutId = Omit<StoredCard, "cardId">;

function normalizedCardText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function cardDedupeKey(card: Pick<StoredCard, "sourceId" | "title" | "body">): string {
  return [
    card.sourceId,
    normalizedCardText(card.title),
    normalizedCardText(card.body),
  ].join("\u0000");
}

export function deduplicateCards(
  candidates: CardWithoutId[],
  sourceId: string,
): { cards: StoredCard[]; duplicateCount: number } {
  const cards: StoredCard[] = [];
  const seen = new Set<string>();
  let duplicateCount = 0;

  for (const card of candidates) {
    const key = cardDedupeKey(card);
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key);
    cards.push({
      ...card,
      cardId: `card:${sourceId}:${String(cards.length + 1).padStart(2, "0")}`,
    });
  }

  return { cards, duplicateCount };
}

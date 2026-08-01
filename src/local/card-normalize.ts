import type { StoredCard } from "./store/types";

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

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 卡片稳定 ID（计划 §Task1.6）：内容派生，不是序号派生。
 * 重新策展时内容未变的卡片保持同一 ID，挂在 cardId 上的用户状态（card_states）不会错位。
 */
export async function stableCardId(card: Pick<StoredCard, "sourceId" | "title" | "body">): Promise<string> {
  return `card:${card.sourceId}:${(await sha256Hex(cardDedupeKey(card))).slice(0, 12)}`;
}

export async function deduplicateCards(
  candidates: CardWithoutId[],
  sourceId: string,
): Promise<{ cards: StoredCard[]; duplicateCount: number }> {
  const cards: StoredCard[] = [];
  const seen = new Set<string>();
  let duplicateCount = 0;

  for (const card of candidates) {
    if (card.sourceId !== sourceId) {
      throw new Error(`deduplicateCards 收到跨 source 卡片：期望 ${sourceId}，实际 ${card.sourceId}`);
    }
    const key = cardDedupeKey(card);
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key);
    cards.push({
      ...card,
      cardId: await stableCardId(card),
    });
  }

  return { cards, duplicateCount };
}

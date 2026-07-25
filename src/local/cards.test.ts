import assert from "node:assert/strict";
import test from "node:test";
import { deduplicateCards, type CardWithoutId } from "./card-normalize.js";

function generated(title: string, body: string): CardWithoutId {
  return {
    sourceId: "web:example.com:dedupe",
    cardType: "insight",
    title,
    body,
    domainLabels: ["测试"],
    evidence: [{ blockId: "block:paragraph:001", quote: "可追溯的原文证据。" }],
    embedding: null,
    createdAt: "2026-07-26T00:00:00.000Z",
  };
}

test("drops repeated generated cards and keeps card ids contiguous", () => {
  const result = deduplicateCards(
    [
      generated("同一张卡", "同一段卡片正文"),
      generated(" 同一张卡 ", "同一段卡片正文"),
      generated("同一张卡", "  同一段卡片正文  "),
      generated("另一张卡", "另一段卡片正文"),
    ],
    "web:example.com:dedupe",
  );

  assert.equal(result.duplicateCount, 2);
  assert.deepEqual(
    result.cards.map((card) => ({ cardId: card.cardId, title: card.title, body: card.body })),
    [
      {
        cardId: "card:web:example.com:dedupe:01",
        title: "同一张卡",
        body: "同一段卡片正文",
      },
      {
        cardId: "card:web:example.com:dedupe:02",
        title: "另一张卡",
        body: "另一段卡片正文",
      },
    ],
  );
});

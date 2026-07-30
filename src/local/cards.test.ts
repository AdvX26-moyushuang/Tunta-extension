import assert from "node:assert/strict";
import test from "node:test";
import { deduplicateCards, type CardWithoutId } from "./card-normalize.js";
import { toValidEntities } from "./cards.js";

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

test("drops repeated generated cards and derives stable content-based card ids", async () => {
  const result = await deduplicateCards(
    [
      generated("同一张卡", "同一段卡片正文"),
      generated(" 同一张卡 ", "同一段卡片正文"),
      generated("同一张卡", "  同一段卡片正文  "),
      generated("另一张卡", "另一段卡片正文"),
    ],
    "web:example.com:dedupe",
  );

  assert.equal(result.duplicateCount, 2);
  assert.equal(result.cards.length, 2);
  // ID 是内容派生的（计划 §Task1.6）：card:${sourceId}:${sha256 前 12 位}
  for (const card of result.cards) {
    assert.match(card.cardId, /^card:web:example\.com:dedupe:[0-9a-f]{12}$/);
  }
  assert.notEqual(result.cards[0].cardId, result.cards[1].cardId);
});

test("re-curation keeps card ids stable when content is unchanged", async () => {
  // 计划验收：同一 source 连续两次策展，内容未变的卡片 cardId 不变——
  // 即使 LLM 少产一张卡、换个顺序，ID 也不会错位到另一段知识上。
  const first = await deduplicateCards(
    [generated("卡 A", "正文 A"), generated("卡 B", "正文 B"), generated("卡 C", "正文 C")],
    "web:example.com:dedupe",
  );
  const second = await deduplicateCards(
    [generated("卡 C", "正文 C"), generated("卡 A", "正文 A")], // 少了卡 B，顺序颠倒
    "web:example.com:dedupe",
  );

  const firstIds = new Map(first.cards.map((card) => [card.title, card.cardId]));
  for (const card of second.cards) {
    assert.equal(card.cardId, firstIds.get(card.title));
  }
});

test("toValidEntities：type 限死六个值、lower(name)+type 去重、每卡最多 5 个（计划 §Task3.1）", () => {
  // 非法 type / 空 name / 超长 name 丢弃，大小写视为同一实体
  assert.deepEqual(
    toValidEntities([
      { name: "约束", type: "concept" },
      { name: "Claude", type: "tool" },
      { name: "claude", type: "tool" }, // 大小写重复
      { name: "约束", type: "alien" }, // 越界 type
      { name: "", type: "person" }, // 空 name
      { name: "x".repeat(41), type: "person" }, // 超长 name
    ]),
    [
      { name: "约束", type: "concept" },
      { name: "Claude", type: "tool" },
    ],
  );

  // 非数组输入不抛错，落空数组
  assert.deepEqual(toValidEntities(undefined), []);
  assert.deepEqual(toValidEntities("entities"), []);

  // 同 type 不同 name 不算重复；超出 5 个截断
  const many = toValidEntities(
    ["a", "b", "c", "d", "e", "f", "g"].map((name) => ({ name, type: "concept" })),
  );
  assert.equal(many.length, 5);
});

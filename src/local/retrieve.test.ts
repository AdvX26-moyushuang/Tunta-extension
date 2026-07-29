import assert from "node:assert/strict";
import test from "node:test";
import { retrieveHits, type ChunkVectorHit } from "./retrieve.js";
import type { StoredCard, StoredChunk } from "./store/types.js";

// ---- 计划 §Task2.3：RetrieveHit 联合形态的合并与排序规则 ----

function makeCard(cardId: string, embedding: number[] | null = null): StoredCard {
  return {
    cardId,
    sourceId: "src-a",
    cardType: "insight",
    title: `标题 ${cardId}`,
    body: "正文",
    domainLabels: [],
    evidence: [],
    embedding,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeChunkHit(chunkId: string, score: number): ChunkVectorHit {
  const chunk: StoredChunk = {
    chunkId,
    sourceId: "src-a",
    text: `原文片段 ${chunkId}`,
    blockIds: ["block:transcript:000"],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  return { chunk, score };
}

test("retrieveHits：同分时卡片优先于 chunk（卡片已过质量判断，chunk 只是原文兜底）", () => {
  const card = makeCard("card:a:1");
  // 卡片只走 FTS rank 0，chunk 只走向量 rank 0：两边 RRF 得分完全相同
  const hits = retrieveHits([card], [{ cardId: "card:a:1", score: 5 }], [makeChunkHit("chunk:src-a:000", 0.9)], 10, [1, 0]);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].kind, "card");
  assert.equal(hits[1].kind, "chunk");
  assert.equal(hits[0].score, hits[1].score);
});

test("retrieveHits：chunk 向量命中进入合并，低于 0.05 地板的被过滤", () => {
  const hits = retrieveHits([], [], [makeChunkHit("chunk:src-a:000", 0.8), makeChunkHit("chunk:src-a:001", 0.04)], 10, [1, 0]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "chunk");
  assert.deepEqual(hits[0].matchedBy, ["vector"]);
  assert.equal(hits[0].kind === "chunk" && hits[0].chunk.chunkId, "chunk:src-a:000");
});

test("retrieveHits：card 向量与 chunk 向量混成一路排名，双通道卡片仍排最前", () => {
  const both = makeCard("card:a:both", [1, 0]); // FTS + 向量双命中
  const ftsOnly = makeCard("card:a:fts");
  const hits = retrieveHits(
    [both, ftsOnly],
    [{ cardId: "card:a:fts", score: 6 }, { cardId: "card:a:both", score: 5 }],
    [makeChunkHit("chunk:src-a:000", 0.5)],
    10,
    [1, 0],
  );
  assert.equal(hits[0].kind === "card" && hits[0].card.cardId, "card:a:both");
  assert.deepEqual(hits[0].matchedBy.slice().sort(), ["fts", "vector"]);
  // chunk 得分 0.5 排向量第二名，也进结果
  assert.ok(hits.some((hit) => hit.kind === "chunk"));
});

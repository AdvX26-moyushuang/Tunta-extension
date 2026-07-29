import assert from "node:assert/strict";
import test from "node:test";
import { CHUNK_MAX_CHARS, chunkBlocks } from "./chunk.js";
import type { ParserBlock } from "./parser.js";

// ---- 计划 §Task2.3 验收：chunk 聚合数量区间与 blockIds 回溯 ----

function makeBlock(index: number, text: string): ParserBlock {
  return {
    block_id: `block:transcript:${String(index).padStart(3, "0")}`,
    order: index,
    kind: "transcript",
    text,
    parent_block_id: null,
    locator: { kind: "unknown", start_ms: null, end_ms: null, page_number: null, paragraph_index: null, selector: null },
    asset_ids: [],
    metadata: {},
  };
}

test("chunkBlocks：字幕流聚合到目标窗口，长视频落在 30~80 区间", () => {
  // 模拟 2000 条 15 字字幕（长视频量级），绝不产出上千 chunk
  const blocks = Array.from({ length: 2000 }, (_, i) => makeBlock(i, "字幕内容大约十五个字的样子"));
  const chunks = chunkBlocks("bilibili:BVtest", blocks);
  assert.ok(chunks.length >= 30 && chunks.length <= 80, `chunk 数 ${chunks.length} 超出 30~80 区间`);
  // 每个 chunk 不超过上限太多（拼接换行符额外占位），blockIds 完整覆盖全部非空 block
  assert.ok(chunks.every((chunk) => chunk.text.length <= CHUNK_MAX_CHARS + 40));
  assert.equal(chunks.reduce((n, chunk) => n + chunk.blockIds.length, 0), blocks.length);
  assert.equal(chunks[0].sourceId, "bilibili:BVtest");
});

test("chunkBlocks：确定性 id、空 block 跳过、超长单 block 不切开", () => {
  const blocks = [makeBlock(0, "短句"), makeBlock(1, "   "), makeBlock(2, "长".repeat(1200)), makeBlock(3, "结尾")];
  const chunks = chunkBlocks("src-a", blocks);
  // 空白 block 不进任何 chunk；超长 block 独立成块保持 blockIds 完整
  assert.deepEqual(chunks.map((chunk) => chunk.blockIds), [
    ["block:transcript:000"],
    ["block:transcript:002"],
    ["block:transcript:003"],
  ]);
  assert.deepEqual(chunks.map((chunk) => chunk.chunkId), ["chunk:src-a:000", "chunk:src-a:001", "chunk:src-a:002"]);
  // 同一输入重跑得到相同 id（embed 去重依赖这一点）
  assert.deepEqual(chunkBlocks("src-a", blocks), chunks);
  assert.deepEqual(chunkBlocks("src-a", []), []);
});

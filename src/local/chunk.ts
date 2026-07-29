import type { ParserBlock } from "./parser";

/**
 * 原文聚合块（计划 §Task2.3）：embedding 的最小单位。
 * 绝对不逐 block embed——2000 条字幕的视频逐条 embed 会一次烧掉 2000 个输入。
 */
export interface Chunk {
  chunkId: string;
  sourceId: string;
  text: string;
  blockIds: string[];
}

/** 300~500 字窗口：长文产出 10~30 个 chunk，长视频 30~80 个，不是几百上千。 */
export const CHUNK_TARGET_CHARS = 400;
export const CHUNK_MAX_CHARS = 500;

/**
 * 把连续 block 聚合成 chunk。chunkId 由 sourceId + 序号确定性生成：
 * 同一文档重跑得到相同 id，embed 前查表去重才能命中（禁止对同一 source 重复 embed）。
 * 超长单 block 独立成 chunk 不切开——blockIds 回溯原文时不能只覆盖半个 block。
 */
export function chunkBlocks(sourceId: string, blocks: ParserBlock[]): Chunk[] {
  const chunks: Chunk[] = [];
  let parts: string[] = [];
  let blockIds: string[] = [];
  let length = 0;
  const flush = () => {
    if (length === 0) return;
    chunks.push({
      chunkId: `chunk:${sourceId}:${String(chunks.length).padStart(3, "0")}`,
      sourceId,
      text: parts.join("\n"),
      blockIds,
    });
    parts = [];
    blockIds = [];
    length = 0;
  };
  for (const block of blocks) {
    const text = block.text.trim();
    if (!text) continue;
    if (length > 0 && length + text.length > CHUNK_MAX_CHARS) flush();
    parts.push(text);
    blockIds.push(block.block_id);
    length += text.length;
    if (length >= CHUNK_TARGET_CHARS) flush();
  }
  flush();
  return chunks;
}

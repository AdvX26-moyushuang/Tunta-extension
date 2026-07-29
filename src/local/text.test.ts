import assert from "node:assert/strict";
import test from "node:test";
import { dotProduct, l2Normalize } from "./text.js";

// ---- 计划 §Task2.2 验收：点积与归一化单测 ----

test("l2Normalize：模长归一、方向不变、零向量不产生 NaN", () => {
  const normalized = l2Normalize([3, 4]);
  assert.ok(Math.abs(normalized[0] - 0.6) < 1e-6);
  assert.ok(Math.abs(normalized[1] - 0.8) < 1e-6);
  assert.ok(Math.abs(Math.sqrt(normalized[0] ** 2 + normalized[1] ** 2) - 1) < 1e-6);
  // 已归一化的向量再归一化不变；零向量原样返回全零
  assert.ok(Math.abs(l2Normalize(normalized)[0] - normalized[0]) < 1e-6);
  assert.deepEqual([...l2Normalize([0, 0, 0])], [0, 0, 0]);
});

test("dotProduct：归一化后点积等价余弦相似度，维度不合返回 0", () => {
  // 同向 = 1，正交 = 0，反向 = -1，斜 45° = 1/√2
  assert.ok(Math.abs(dotProduct(l2Normalize([3, 4]), l2Normalize([6, 8])) - 1) < 1e-6);
  assert.ok(Math.abs(dotProduct(l2Normalize([1, 0]), l2Normalize([0, 1]))) < 1e-6);
  assert.ok(Math.abs(dotProduct(l2Normalize([1, 2]), l2Normalize([-1, -2])) + 1) < 1e-6);
  assert.ok(Math.abs(dotProduct(l2Normalize([1, 0]), l2Normalize([1, 1])) - Math.SQRT1_2) < 1e-6);
  assert.equal(dotProduct([1, 2], [1, 2, 3]), 0);
  assert.equal(dotProduct([], []), 0);
});

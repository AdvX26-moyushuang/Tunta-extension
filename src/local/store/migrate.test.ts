import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MemoryStore } from "./memory-store.js";
import { MIGRATION_KEY, readMigrationState, runMigration } from "./migrate.js";
import { SqlCore, type SqlDriver } from "./sql-core.js";
import type { StoredCard, TuntaStore } from "./types.js";

// chrome.storage.local 的内存桩：迁移进度状态存这里
const storageData = new Map<string, unknown>();
(globalThis as { chrome?: unknown }).chrome = {
  storage: {
    local: {
      async get(key: string) {
        return { [key]: storageData.get(key) };
      },
      async set(items: Record<string, unknown>) {
        for (const [key, value] of Object.entries(items)) storageData.set(key, value);
      },
    },
  },
};

function createNodeSqliteStore(): TuntaStore {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const driver: SqlDriver = {
    async exec(sql, params = []) {
      if (params.length === 0) {
        db.exec(sql);
        return;
      }
      db.prepare(sql).run(...params);
    },
    async query(sql, params = []) {
      return db.prepare(sql).all(...params) as Record<string, unknown>[];
    },
  };
  return new SqlCore(driver);
}

async function seedSource(): Promise<TuntaStore> {
  const source = new MemoryStore();
  for (let i = 1; i <= 25; i += 1) {
    await source.putCapture({
      captureId: `cap-${i}`,
      url: `https://example.com/${i}`,
      title: `收藏 ${i}`,
      intent: "pending",
      status: "done",
      sourceId: i <= 5 ? `src-${i}` : null,
      createdAt: `2026-01-${String(i).padStart(2, "0")}T00:00:00.000Z`,
      updatedAt: `2026-01-${String(i).padStart(2, "0")}T00:00:00.000Z`,
      archived: false,
      failure: null,
    });
  }
  for (let i = 1; i <= 5; i += 1) {
    await source.putDocument({
      sourceId: `src-${i}`,
      url: `https://example.com/${i}`,
      title: `文档 ${i}`,
      platform: "web",
      contentHash: `hash-${i}`,
      parserOutput: {
        schema_version: "0.1.0",
        source: {
          source_id: `src-${i}`,
          original_url: `https://example.com/${i}`,
          canonical_url: null,
          platform: "web",
          content_type: "article",
          title: `文档 ${i}`,
          author: null,
          published_at: null,
          fetched_at: "2026-01-01T00:00:00.000Z",
          language: null,
          raw_content_ref: null,
        },
        blocks: [],
        assets: [],
        parse: {
          job_id: `job-${i}`,
          parser_name: "test",
          parser_version: "0.0.0",
          status: "completed",
          parsed_at: "2026-01-01T00:00:00.000Z",
          content_hash: `hash-${i}`,
          warnings: [],
          errors: [],
        },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  }
  const cards: StoredCard[] = [];
  for (let i = 1; i <= 10; i += 1) {
    cards.push({
      cardId: `card-${i}`,
      sourceId: `src-${((i - 1) % 5) + 1}`,
      cardType: "insight",
      title: `卡片 ${i}`,
      body: `正文 ${i}`,
      domainLabels: ["测试"],
      evidence: [{ blockId: `block-${i}`, quote: null }],
      embedding: i % 2 === 0 ? [0.1, 0.2] : null,
      createdAt: "2026-01-02T00:00:00.000Z",
    });
  }
  // 两张孤儿卡片：document 缺失，迁移时应跳过而不是失败
  cards.push({ ...cards[0], cardId: "card-orphan-1", sourceId: "src-ghost" });
  cards.push({ ...cards[1], cardId: "card-orphan-2", sourceId: "src-ghost" });
  await source.putCards(cards);
  return source;
}

test("迁移：全量搬运、行数校验、孤儿卡片跳过、幂等", async () => {
  storageData.clear();
  const source = await seedSource();
  const target = createNodeSqliteStore();

  assert.equal(await runMigration(source, target), true);

  // 数量对比（计划验收）：captures/documents 全量，cards 扣掉 2 张孤儿
  assert.equal((await target.listCaptures()).length, 25);
  assert.equal((await target.listDocuments()).length, 5);
  assert.equal((await target.listCards()).length, 10);

  // 内容对比：逐条深比较（等价于内容哈希一致）
  assert.deepEqual(await target.listCaptures(), await source.listCaptures());
  const byId = (a: { cardId: string }, b: { cardId: string }) => a.cardId.localeCompare(b.cardId);
  const sourceCards = (await source.listCards()).filter((card) => card.sourceId !== "src-ghost");
  assert.deepEqual([...(await target.listCards())].sort(byId), [...sourceCards].sort(byId));
  assert.deepEqual(await target.getDocument("src-3"), await source.getDocument("src-3"));

  const state = await readMigrationState();
  assert.ok(state.migratedAt);
  assert.equal(state.skippedOrphanCards, 2);
  assert.deepEqual(state.counts, { captures: 25, documents: 5, cards: 10, chat_history: 0, kaleidoscope_edges: 0 });

  // 幂等：已迁移直接返回 true，不重写
  assert.equal(await runMigration(source, target), true);
});

test("迁移：断点续传跳过已完成的表", async () => {
  storageData.clear();
  const source = await seedSource();
  const target = createNodeSqliteStore();

  // 模拟上一轮已完成 captures 后 SW 被杀
  storageData.set(MIGRATION_KEY, { startedAt: "2026-01-01T00:00:00.000Z", done: { captures: 0 } });

  assert.equal(await runMigration(source, target), true);
  // captures 被跳过（进度记录为准），其余表正常迁移
  assert.equal((await target.listCaptures()).length, 0);
  assert.equal((await target.listDocuments()).length, 5);
  assert.equal((await target.listCards()).length, 10);
});

test("迁移：行数校验失败时中止并保留错误信息", async () => {
  storageData.clear();
  const source = await seedSource();
  const target = createNodeSqliteStore();

  // 包一层会丢文档的 target，模拟写入不完整
  const lossy: TuntaStore = new Proxy(target, {
    get(t, prop: string) {
      if (prop === "putDocument") {
        return async (doc: { sourceId: string }) => (doc.sourceId === "src-5" ? doc : t.putDocument(doc as never));
      }
      const value = t[prop as keyof TuntaStore] as (...args: unknown[]) => unknown;
      return typeof value === "function" ? value.bind(t) : value;
    },
  });

  assert.equal(await runMigration(source, lossy), false);
  const state = await readMigrationState();
  assert.equal(state.migratedAt, undefined);
  assert.match(state.lastError ?? "", /documents 行数校验失败/);
  // captures 已完成的进度保留，供下次续传
  assert.equal(state.done?.captures, 25);
});

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MemoryStore } from "./memory-store.js";
import { SqlCore, type SqlDriver } from "./sql-core.js";
import type {
  StoredCapture,
  StoredCard,
  StoredChatTurn,
  StoredDocument,
  StoredKaleidoscopeEdge,
  TuntaStore,
} from "./types.js";

/** 用 node:sqlite 跑同一份 SQL（计划 §Task1.3 验收方式），生产路径是 sqlite-wasm + OPFS。 */
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

/**
 * TuntaStore 契约测试：跑在任意实现上。
 * IdbStore 在 Node 里没有 indexedDB，跳过；SqliteStore 的 SQL 主体（SqlCore）用 node:sqlite 验证。
 */
const implementations: { name: string; create: () => TuntaStore }[] = [
  { name: "MemoryStore", create: () => new MemoryStore() },
  { name: "SqlCore(node:sqlite)", create: createNodeSqliteStore },
];

function makeCapture(overrides: Partial<StoredCapture> & { captureId: string; url: string }): StoredCapture {
  return {
    title: "",
    intent: "pending",
    status: "idle",
    sourceId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archived: false,
    failure: null,
    ...overrides,
  };
}

function makeCard(overrides: Partial<StoredCard> & { cardId: string; sourceId: string }): StoredCard {
  return {
    cardType: "insight",
    title: "标题",
    body: "正文",
    domainLabels: [],
    evidence: [],
    embedding: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeDocument(sourceId: string): StoredDocument {
  return {
    sourceId,
    url: `https://example.com/${sourceId}`,
    title: `文档 ${sourceId}`,
    platform: "web",
    contentHash: "hash",
    parserOutput: {
      schema_version: "0.1.0",
      source: {
        source_id: sourceId,
        original_url: `https://example.com/${sourceId}`,
        canonical_url: null,
        platform: "web",
        content_type: "article",
        title: `文档 ${sourceId}`,
        author: null,
        published_at: null,
        fetched_at: "2026-01-01T00:00:00.000Z",
        language: null,
        raw_content_ref: null,
      },
      blocks: [],
      assets: [],
      parse: {
        job_id: `job:${sourceId}`,
        parser_name: "test",
        parser_version: "0.0.0",
        status: "completed",
        parsed_at: "2026-01-01T00:00:00.000Z",
        content_hash: "hash",
        warnings: [],
        errors: [],
      },
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeChatTurn(queryId: string, createdAt: string): StoredChatTurn {
  return {
    queryId,
    query: `问题 ${queryId}`,
    createdAt,
    turn: {
      schema_version: "0.3.0",
      query_id: queryId,
      status: "answered",
      answer: "回答",
      citations: [],
      retrieved_cards: [],
      project_proposal: null,
      generation: { provider: "test", model: "test", latency_ms: 0 },
    },
  };
}

function makeEdge(from: string, to: string): StoredKaleidoscopeEdge {
  return {
    edgeId: `kedge:${[from, to].sort().join("::")}`,
    fromSourceId: from,
    toSourceId: to,
    relation: "相关",
    strength: 0.5,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

for (const impl of implementations) {
  test(`[${impl.name}] captures：增改查与按 createdAt 倒序`, async () => {
    const store = impl.create();
    await store.putCapture(makeCapture({ captureId: "c1", url: "https://a.com", createdAt: "2026-01-01T00:00:00.000Z" }));
    await store.putCapture(makeCapture({ captureId: "c2", url: "https://b.com", createdAt: "2026-01-03T00:00:00.000Z" }));
    await store.putCapture(makeCapture({ captureId: "c3", url: "https://c.com", createdAt: "2026-01-02T00:00:00.000Z" }));

    const listed = await store.listCaptures();
    assert.deepEqual(listed.map((item) => item.captureId), ["c2", "c3", "c1"]);

    assert.equal((await store.getCapture("c1"))?.url, "https://a.com");
    assert.equal((await store.getCaptureByUrl("https://b.com"))?.captureId, "c2");
    assert.equal(await store.getCapture("missing"), undefined);
    assert.equal(await store.getCaptureByUrl("https://missing.com"), undefined);

    // 同 key 覆盖更新
    await store.putCapture(makeCapture({ captureId: "c1", url: "https://a.com", status: "done" }));
    assert.equal((await store.getCapture("c1"))?.status, "done");
    assert.equal((await store.listCaptures()).length, 3);
  });

  test(`[${impl.name}] documents：增改查`, async () => {
    const store = impl.create();
    await store.putDocument(makeDocument("src-1"));
    await store.putDocument(makeDocument("src-2"));
    assert.equal((await store.getDocument("src-1"))?.title, "文档 src-1");
    assert.equal((await store.listDocuments()).length, 2);

    await store.putDocument({ ...makeDocument("src-1"), curatedTitle: "策展标题" });
    assert.equal((await store.getDocument("src-1"))?.curatedTitle, "策展标题");
    assert.equal((await store.listDocuments()).length, 2);
  });

  test(`[${impl.name}] cards：putCards / listCardsBySource / putCard`, async () => {
    const store = impl.create();
    // SQL schema 里 cards.source_id 外键指向 documents，与真实业务一致：先写文档再写卡片
    await store.putDocument(makeDocument("src-a"));
    await store.putDocument(makeDocument("src-b"));
    await store.putCards([
      makeCard({ cardId: "card:a:1", sourceId: "src-a" }),
      makeCard({ cardId: "card:a:2", sourceId: "src-a" }),
      makeCard({ cardId: "card:b:1", sourceId: "src-b" }),
    ]);
    assert.equal((await store.listCards()).length, 3);
    assert.equal((await store.listCardsBySource("src-a")).length, 2);
    assert.equal((await store.listCardsBySource("src-b")).length, 1);
    assert.equal((await store.listCardsBySource("src-none")).length, 0);

    await store.putCard(makeCard({ cardId: "card:a:1", sourceId: "src-a", title: "更新后" }));
    const updated = (await store.listCardsBySource("src-a")).find((card) => card.cardId === "card:a:1");
    assert.equal(updated?.title, "更新后");
  });

  test(`[${impl.name}] replaceCardsForSource：只替换本 source，跨 source 报错`, async () => {
    const store = impl.create();
    await store.putDocument(makeDocument("src-a"));
    await store.putDocument(makeDocument("src-b"));
    await store.putCards([
      makeCard({ cardId: "card:a:1", sourceId: "src-a" }),
      makeCard({ cardId: "card:a:2", sourceId: "src-a" }),
      makeCard({ cardId: "card:b:1", sourceId: "src-b" }),
    ]);

    await store.replaceCardsForSource("src-a", [makeCard({ cardId: "card:a:3", sourceId: "src-a" })]);
    assert.deepEqual(
      (await store.listCardsBySource("src-a")).map((card) => card.cardId),
      ["card:a:3"],
    );
    // 其他 source 不受影响
    assert.equal((await store.listCardsBySource("src-b")).length, 1);

    await assert.rejects(
      store.replaceCardsForSource("src-a", [makeCard({ cardId: "card:b:9", sourceId: "src-b" })]),
      /跨 source/,
    );

    // 替换为空数组 = 清空该 source 的卡片
    await store.replaceCardsForSource("src-a", []);
    assert.equal((await store.listCardsBySource("src-a")).length, 0);
  });

  test(`[${impl.name}] chat history：倒序与 pruneChatTurns 保留数量`, async () => {
    const store = impl.create();
    for (let i = 1; i <= 5; i += 1) {
      await store.putChatTurn(makeChatTurn(`q${i}`, `2026-01-0${i}T00:00:00.000Z`));
    }
    const listed = await store.listChatTurns();
    assert.deepEqual(listed.map((record) => record.queryId), ["q5", "q4", "q3", "q2", "q1"]);
    assert.equal((await store.getChatTurnRecord("q3"))?.query, "问题 q3");

    await store.pruneChatTurns(2);
    const kept = await store.listChatTurns();
    assert.deepEqual(kept.map((record) => record.queryId), ["q5", "q4"]);

    // keep 大于现存数量时不删任何东西
    await store.pruneChatTurns(10);
    assert.equal((await store.listChatTurns()).length, 2);
  });

  test(`[${impl.name}] kaleidoscope edges：写入、按 source 删除、清空`, async () => {
    const store = impl.create();
    await store.putKaleidoscopeEdges([makeEdge("s1", "s2"), makeEdge("s1", "s3"), makeEdge("s2", "s3")]);
    assert.equal((await store.listKaleidoscopeEdges()).length, 3);

    await store.deleteKaleidoscopeEdgesForSource("s1");
    const remaining = await store.listKaleidoscopeEdges();
    assert.deepEqual(remaining.map((edge) => edge.edgeId), [makeEdge("s2", "s3").edgeId]);

    await store.putKaleidoscopeEdges([]);
    assert.equal((await store.listKaleidoscopeEdges()).length, 1);

    await store.clearKaleidoscopeEdges();
    assert.equal((await store.listKaleidoscopeEdges()).length, 0);
  });

  test(`[${impl.name}] clearAllLocalData：五张表全部清空`, async () => {
    const store = impl.create();
    await store.putCapture(makeCapture({ captureId: "c1", url: "https://a.com" }));
    await store.putDocument(makeDocument("src-1"));
    await store.putCards([makeCard({ cardId: "card:1", sourceId: "src-1" })]);
    await store.putChatTurn(makeChatTurn("q1", "2026-01-01T00:00:00.000Z"));
    await store.putKaleidoscopeEdges([makeEdge("s1", "s2")]);

    await store.clearAllLocalData();
    assert.equal((await store.listCaptures()).length, 0);
    assert.equal((await store.listDocuments()).length, 0);
    assert.equal((await store.listCards()).length, 0);
    assert.equal((await store.listChatTurns()).length, 0);
    assert.equal((await store.listKaleidoscopeEdges()).length, 0);
  });
}

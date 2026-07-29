import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MemoryStore } from "./memory-store.js";
import { SqlCore, type SqlDriver } from "./sql-core.js";
import type {
  StoredCapture,
  StoredCard,
  StoredChatTurn,
  StoredChunk,
  StoredDocument,
  StoredEmbedding,
  StoredKaleidoscopeEdge,
  TuntaStore,
} from "./types.js";

/** 用 node:sqlite 跑同一份 SQL（计划 §Task1.3 验收方式），生产路径是 sqlite-wasm + OPFS。 */
function createNodeDriver(): SqlDriver {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return {
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
}

function createNodeSqliteStore(): TuntaStore {
  return new SqlCore(createNodeDriver());
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

function makeEmbedding(overrides: Partial<StoredEmbedding> & { ownerId: string; vector: number[] }): StoredEmbedding {
  return {
    ownerKind: "card",
    model: "test-model",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeChunk(chunkId: string, sourceId: string): StoredChunk {
  return {
    chunkId,
    sourceId,
    text: `原文片段 ${chunkId}`,
    blockIds: ["block:paragraph:000", "block:paragraph:001"],
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

  test(`[${impl.name}] searchCardsFts：中文 query 命中与打分单调`, async () => {
    const store = impl.create();
    await store.putDocument(makeDocument("src-f"));
    await store.putCards([
      makeCard({
        cardId: "card:ml-dense",
        sourceId: "src-f",
        title: "机器学习入门",
        body: "机器学习是人工智能的分支，机器学习模型需要大量数据训练",
      }),
      makeCard({
        cardId: "card:ml-sparse",
        sourceId: "src-f",
        title: "工具清单",
        body: "这份清单里只顺带提到了一次机器学习而已，其余都是无关内容",
      }),
      makeCard({ cardId: "card:cook", sourceId: "src-f", title: "红烧肉做法", body: "先焯水再炖煮收汁" }),
    ]);

    const hits = await store.searchCardsFts("机器学习", 10);
    // 无关卡不入选；命中多的卡排在命中少的前面（打分单调）
    assert.deepEqual(hits.map((hit) => hit.cardId), ["card:ml-dense", "card:ml-sparse"]);
    assert.ok(hits[0].score > hits[1].score);
    assert.ok(hits.every((hit) => hit.score > 0));

    // 英文 query 大小写不敏感（tokenize 统一小写）
    await store.putCard(makeCard({ cardId: "card:en", sourceId: "src-f", title: "SQLite WASM", body: "OPFS notes" }));
    assert.equal((await store.searchCardsFts("sqlite", 10))[0]?.cardId, "card:en");

    // 无关 query 不命中；limit 生效
    assert.deepEqual(await store.searchCardsFts("量子物理", 10), []);
    assert.equal((await store.searchCardsFts("机器学习", 1)).length, 1);
  });

  test(`[${impl.name}] searchCardsFts：索引跟随策展替换与卡片更新`, async () => {
    const store = impl.create();
    await store.putDocument(makeDocument("src-g"));
    await store.putCards([makeCard({ cardId: "card:old", sourceId: "src-g", title: "机器学习笔记", body: "旧内容" })]);
    assert.equal((await store.searchCardsFts("机器学习", 10))[0]?.cardId, "card:old");

    // 策展重跑换卡：旧卡退出索引，新卡可检索
    await store.replaceCardsForSource("src-g", [makeCard({ cardId: "card:new", sourceId: "src-g", title: "红烧肉入门", body: "焯水炖煮" })]);
    assert.deepEqual(await store.searchCardsFts("机器学习", 10), []);
    assert.equal((await store.searchCardsFts("红烧肉", 10))[0]?.cardId, "card:new");

    // putCard 覆盖更新：索引同步新文本
    await store.putCard(makeCard({ cardId: "card:new", sourceId: "src-g", title: "深度学习进阶", body: "神经网络" }));
    assert.deepEqual(await store.searchCardsFts("红烧肉", 10), []);
    assert.equal((await store.searchCardsFts("深度学习", 10))[0]?.cardId, "card:new");
  });

  test(`[${impl.name}] embeddings：归一化点积检索与 model/维度隔离`, async () => {
    const store = impl.create();
    await store.putEmbeddings([
      // 故意存未归一化的向量：[3,4] 与 [0.6,0.8] 方向相同，归一化后得分应相同
      makeEmbedding({ ownerId: "card:x", vector: [3, 4] }),
      makeEmbedding({ ownerId: "card:y", vector: [4, 3] }),
      makeEmbedding({ ownerId: "card:opposite", vector: [-3, -4] }),
      makeEmbedding({ ownerId: "chunk:1", ownerKind: "chunk", vector: [3, 4] }),
      // 其他模型/其他维度：不参与本 model 的检索
      makeEmbedding({ ownerId: "card:other-model", model: "other", vector: [3, 4] }),
      makeEmbedding({ ownerId: "card:other-dim", vector: [1, 0, 0] }),
    ]);

    const hits = await store.searchEmbeddings([0.6, 0.8], "test-model", 10);
    assert.deepEqual(
      hits.map((hit) => hit.ownerId),
      ["card:x", "chunk:1", "card:y", "card:opposite"],
    );
    // 同向向量归一化后点积≈ 1，反向≈ -1
    assert.ok(Math.abs(hits[0].score - 1) < 1e-6);
    assert.ok(Math.abs(hits[3].score + 1) < 1e-6);

    // ownerKind 过滤 + topK 截断
    const cardsOnly = await store.searchEmbeddings([0.6, 0.8], "test-model", 2, "card");
    assert.deepEqual(cardsOnly.map((hit) => hit.ownerId), ["card:x", "card:y"]);

    // 同 (ownerKind, ownerId, model) 覆盖更新：方向反转后得分变≈ -1（不新增行）
    await store.putEmbeddings([makeEmbedding({ ownerId: "card:x", vector: [-0.6, -0.8] })]);
    const after = await store.searchEmbeddings([0.6, 0.8], "test-model", 10, "card");
    assert.equal(after.length, 3);
    assert.equal(after[0]?.ownerId, "card:y");
    const overwritten = after.find((hit) => hit.ownerId === "card:x");
    assert.ok(overwritten && Math.abs(overwritten.score + 1) < 1e-6);
  });

  test(`[${impl.name}] embeddings：listEmbeddingModels 盘点与 deleteEmbeddings 清理`, async () => {
    const store = impl.create();
    await store.putEmbeddings([
      makeEmbedding({ ownerId: "card:1", vector: [1, 0] }),
      makeEmbedding({ ownerId: "card:2", vector: [0, 1] }),
      makeEmbedding({ ownerId: "chunk:1", ownerKind: "chunk", vector: [1, 1] }),
      makeEmbedding({ ownerId: "card:legacy", model: "legacy-model", vector: [1, 0, 0] }),
    ]);

    // model/dim 显式存：换模型后能盘点出旧向量，不静默丢弃
    assert.deepEqual(await store.listEmbeddingModels(), [
      { model: "legacy-model", dim: 3, count: 1 },
      { model: "test-model", dim: 2, count: 3 },
    ]);

    // 只删指定 ownerKind + ownerIds；同 id 的 chunk 不受影响
    await store.deleteEmbeddings("card", ["card:1", "card:2"]);
    assert.deepEqual(await store.listEmbeddingModels(), [
      { model: "legacy-model", dim: 3, count: 1 },
      { model: "test-model", dim: 2, count: 1 },
    ]);
    assert.equal((await store.searchEmbeddings([1, 1], "test-model", 10))[0]?.ownerId, "chunk:1");

    await store.deleteEmbeddings("card", []);
    assert.equal((await store.listEmbeddingModels()).length, 2);
  });

  test(`[${impl.name}] chunks：replaceChunksForSource 只替换本 source，跨 source 报错`, async () => {
    const store = impl.create();
    await store.replaceChunksForSource("src-a", [makeChunk("chunk:src-a:000", "src-a"), makeChunk("chunk:src-a:001", "src-a")]);
    await store.replaceChunksForSource("src-b", [makeChunk("chunk:src-b:000", "src-b")]);
    assert.equal((await store.listChunksBySource("src-a")).length, 2);
    assert.deepEqual((await store.listChunksBySource("src-a"))[0]?.blockIds, ["block:paragraph:000", "block:paragraph:001"]);

    // 重新聚合：本 source 全量替换，其他 source 不受影响
    await store.replaceChunksForSource("src-a", [makeChunk("chunk:src-a:000", "src-a")]);
    assert.deepEqual((await store.listChunksBySource("src-a")).map((chunk) => chunk.chunkId), ["chunk:src-a:000"]);
    assert.equal((await store.listChunksBySource("src-b")).length, 1);

    await assert.rejects(store.replaceChunksForSource("src-a", [makeChunk("chunk:src-b:009", "src-b")]), /跨 source/);
    await store.replaceChunksForSource("src-a", []);
    assert.equal((await store.listChunksBySource("src-a")).length, 0);
  });

  test(`[${impl.name}] embeddings：listEmbeddedOwnerIds 按 ownerKind + model 去重查表`, async () => {
    const store = impl.create();
    await store.putEmbeddings([
      makeEmbedding({ ownerId: "card:1", vector: [1, 0] }),
      makeEmbedding({ ownerId: "chunk:src-a:000", ownerKind: "chunk", vector: [0, 1] }),
      makeEmbedding({ ownerId: "card:legacy", model: "legacy-model", vector: [1, 1] }),
    ]);
    // 只返回指定 ownerKind + model 的 id：Task2.3 的 embed 去重靠这个查表命中
    assert.deepEqual(await store.listEmbeddedOwnerIds("card", "test-model"), ["card:1"]);
    assert.deepEqual(await store.listEmbeddedOwnerIds("chunk", "test-model"), ["chunk:src-a:000"]);
    assert.deepEqual(await store.listEmbeddedOwnerIds("chunk", "legacy-model"), []);
  });

  test(`[${impl.name}] clearAllLocalData：七张表全部清空`, async () => {
    const store = impl.create();
    await store.putCapture(makeCapture({ captureId: "c1", url: "https://a.com" }));
    await store.putDocument(makeDocument("src-1"));
    await store.putCards([makeCard({ cardId: "card:1", sourceId: "src-1" })]);
    await store.putChatTurn(makeChatTurn("q1", "2026-01-01T00:00:00.000Z"));
    await store.putKaleidoscopeEdges([makeEdge("s1", "s2")]);
    await store.putEmbeddings([makeEmbedding({ ownerId: "card:1", vector: [1, 0] })]);
    await store.replaceChunksForSource("src-1", [makeChunk("chunk:src-1:000", "src-1")]);

    await store.clearAllLocalData();
    assert.equal((await store.listCaptures()).length, 0);
    assert.equal((await store.listDocuments()).length, 0);
    assert.equal((await store.listCards()).length, 0);
    assert.equal((await store.listChatTurns()).length, 0);
    assert.equal((await store.listKaleidoscopeEdges()).length, 0);
    assert.deepEqual(await store.searchCardsFts("标题", 10), []);
    assert.deepEqual(await store.listEmbeddingModels(), []);
    assert.deepEqual(await store.listChunksBySource("src-1"), []);
  });
}

// ---- card_states（计划 §Task1.6）：SqlCore 专属，不在 TuntaStore 契约面内 ----

test("card_states：策展重跑（replaceCardsForSource）不影响用户状态", async () => {
  const driver = createNodeDriver();
  const store = new SqlCore(driver);

  await store.putDocument(makeDocument("src-1"));
  await store.putCards([makeCard({ cardId: "card:a", sourceId: "src-1" })]);
  // 用户给卡片写状态（Phase 5 的读写 API 尚未建，直接走 SQL）
  await driver.exec(
    "INSERT INTO card_states (card_id, starred, user_note, updated_at) VALUES (?, 1, ?, ?)",
    ["card:a", "我的笔记", "2026-01-01T00:00:00.000Z"],
  );

  // 策展重跑：cards 全删重建，甚至换成另一批卡
  await store.replaceCardsForSource("src-1", [makeCard({ cardId: "card:b", sourceId: "src-1" })]);

  // card_states 不参与替换、无外键级联：孤儿行也必须原样保留
  const states = await driver.query("SELECT * FROM card_states");
  assert.equal(states.length, 1);
  assert.equal(states[0].card_id, "card:a");
  assert.equal(states[0].user_note, "我的笔记");
  assert.equal(Number(states[0].starred), 1);

  const versionRows = await driver.query("PRAGMA user_version");
  assert.equal(Number(versionRows[0]?.user_version), 5);
});

// ---- cards_fts（计划 §Task2.1）：V2 → V3 升级时存量卡片回填索引 ----

test("cards_fts：V2 库升级到 V3 时存量卡片可检索", async () => {
  const driver = createNodeDriver();
  // 先把库建到最新版，再回退成「已有卡片的 V2 库」：删 V3+ 的表 + 降 user_version
  const bootstrap = new SqlCore(driver);
  await bootstrap.putDocument(makeDocument("src-old"));
  await bootstrap.putCards([makeCard({ cardId: "card:legacy", sourceId: "src-old", title: "机器学习旧卡", body: "升级前就存在" })]);
  await driver.exec("DROP TABLE cards_fts");
  await driver.exec("DROP TABLE embeddings");
  await driver.exec("DROP TABLE chunks");
  await driver.exec("PRAGMA user_version = 2");

  // 重新初始化：migrateV3 建表并回填存量卡片，V4/V5 补齐 embeddings / chunks 表
  const upgraded = new SqlCore(driver);
  const hits = await upgraded.searchCardsFts("机器学习", 10);
  assert.equal(hits[0]?.cardId, "card:legacy");
  assert.deepEqual(await upgraded.listEmbeddingModels(), []);
  assert.deepEqual(await upgraded.listChunksBySource("src-old"), []);
});

// ---- 向量检索性能（计划 §Task2.2 验收）：1000 条向量单次检索 <20ms ----

test("embeddings：1000 条 768 维向量单次检索 <20ms", async () => {
  const store = createNodeSqliteStore();
  const dim = 768;
  const batch: StoredEmbedding[] = [];
  for (let i = 0; i < 1000; i += 1) {
    const vector = new Array<number>(dim);
    for (let j = 0; j < dim; j += 1) vector[j] = Math.sin(i * dim + j);
    batch.push(makeEmbedding({ ownerId: `card:${i}`, vector }));
  }
  await store.putEmbeddings(batch);

  const query = batch[500].vector;
  const started = performance.now();
  const hits = await store.searchEmbeddings(query, "test-model", 8);
  const elapsed = performance.now() - started;

  assert.equal(hits.length, 8);
  assert.equal(hits[0].ownerId, "card:500");
  assert.ok(Math.abs(hits[0].score - 1) < 1e-5);
  assert.ok(elapsed < 20, `单次检索耗时 ${elapsed.toFixed(2)}ms，超过 20ms 验收线`);
});

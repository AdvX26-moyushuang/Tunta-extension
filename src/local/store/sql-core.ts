import { l2Normalize, dotProduct, tokenize } from "../text.js";
import {
  CHAT_HISTORY_LIMIT,
  cardFtsText,
  type CardFtsHit,
  type EmbeddingHit,
  type EmbeddingModelInfo,
  type StoredCapture,
  type StoredCard,
  type StoredChatTurn,
  type StoredChunk,
  type StoredDocument,
  type StoredEmbedding,
  type StoredKaleidoscopeEdge,
  type TuntaStore,
} from "./types.js";

/**
 * SQL 层的最小驱动接口：wasm（offscreen worker）与 node:sqlite（契约测试）各自实现。
 * 全部 async，同步驱动包一层即可。Uint8Array 对应 BLOB 列，两侧驱动都原生支持。
 */
export type SqlValue = string | number | null | Uint8Array;

export interface SqlDriver {
  exec(sql: string, params?: SqlValue[]): Promise<void>;
  query(sql: string, params?: SqlValue[]): Promise<Record<string, unknown>[]>;
}

export const SCHEMA_VERSION = 5;

/** 计划 §Task1.3 的三张表 + TuntaStore 需要的 chat_history / kaleidoscope_edges。 */
const SCHEMA_V1 = `
CREATE TABLE captures (
  capture_id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, intent TEXT,
  status TEXT NOT NULL, stage TEXT, source_id TEXT, title TEXT,
  curation_note TEXT, expand_links TEXT, attempts INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0, failure TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_captures_created ON captures(created_at DESC);

CREATE TABLE documents (
  source_id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT,
  curated_title TEXT, summary TEXT, platform TEXT, content_hash TEXT,
  parser_output TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE cards (
  card_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES documents(source_id) ON DELETE CASCADE,
  card_type TEXT, title TEXT, body TEXT,
  domain_labels TEXT, evidence TEXT, embedding TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_cards_source ON cards(source_id);

CREATE TABLE chat_history (
  query_id TEXT PRIMARY KEY, query TEXT NOT NULL,
  turn TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX idx_chat_created ON chat_history(created_at DESC);

CREATE TABLE kaleidoscope_edges (
  edge_id TEXT PRIMARY KEY,
  from_source_id TEXT NOT NULL, to_source_id TEXT NOT NULL,
  relation TEXT NOT NULL, strength REAL NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX idx_kedges_from ON kaleidoscope_edges(from_source_id);
CREATE INDEX idx_kedges_to ON kaleidoscope_edges(to_source_id);
`;

/**
 * 用户状态层（计划 §Task1.6，Phase 5 的前置）。
 * 禁止外键级联（ON DELETE CASCADE）：card_states 不参与 replaceCardsForSource，
 * 策展重跑不能抹掉用户笔记；孤儿行由手动触发的清理任务处理，不自动删。
 */
const SCHEMA_V2 = `
CREATE TABLE card_states (
  card_id TEXT PRIMARY KEY,
  starred INTEGER DEFAULT 0,
  hidden INTEGER DEFAULT 0,
  user_note TEXT,
  review_count INTEGER DEFAULT 0,
  last_reviewed_at TEXT,
  updated_at TEXT NOT NULL
);
`;

/**
 * 向量存储（计划 §Task2.2）。vector 是 L2 归一化后的 Float32Array 字节（BLOB），
 * 相似度 = 纯点积。model/dim 显式存：换模型后能查出旧向量提示重建，不静默丢弃。
 * 不引入 sqlite-vec：n<50k 时 JS 暴力扫描只要个位数 ms。
 */
const SCHEMA_V4 = `
CREATE TABLE embeddings (
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_kind, owner_id, model)
);
`;

/**
 * 原文聚合块（计划 §Task2.3）：chunk 本体持久化，embeddings 只存 chunkId 引用。
 * 不重算的理由：聚合算法迭代后旧向量引用的 chunk 仍能回查到当时的正文。
 */
const SCHEMA_V5 = `
CREATE TABLE chunks (
  chunk_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  text TEXT NOT NULL,
  block_ids TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_chunks_source ON chunks(source_id);
`;

const MIGRATIONS: Record<number, string | ((driver: SqlDriver) => Promise<void>)> = {
  1: SCHEMA_V1,
  2: SCHEMA_V2,
  3: migrateV3,
  4: SCHEMA_V4,
  5: SCHEMA_V5,
};

/**
 * FTS5 全文索引（计划 §Task2.1）。内置 tokenizer 不切中文，
 * fts_text 存的是 JS 侧 tokenize() 预分词后空格连接的文本，禁止写入原始中文。
 * contentless（content=''）+ rowid 对齐 cards.rowid。注意：cards 没有 INTEGER PK，
 * VACUUM 会重编 rowid——如果将来引入 VACUUM，必须同时重建 cards_fts。
 */
async function migrateV3(driver: SqlDriver): Promise<void> {
  await driver.exec(
    "CREATE VIRTUAL TABLE cards_fts USING fts5(fts_text, content='', contentless_delete=1, tokenize='unicode61')",
  );
  // 存量卡片回填（需要 JS 分词，所以这一版不是纯 SQL）
  const rows = await driver.query("SELECT rowid, title, body, domain_labels FROM cards");
  for (const row of rows) {
    const card = {
      title: (row.title as string | null) ?? "",
      body: (row.body as string | null) ?? "",
      domainLabels: typeof row.domain_labels === "string" ? (JSON.parse(row.domain_labels) as string[]) : [],
    };
    await driver.exec("INSERT INTO cards_fts (rowid, fts_text) VALUES (?, ?)", [
      Number(row.rowid),
      tokenize(cardFtsText(card)).join(" "),
    ]);
  }
}

async function initSchema(driver: SqlDriver): Promise<void> {
  const rows = await driver.query("PRAGMA user_version");
  const version = Number(rows[0]?.user_version ?? 0);
  if (version >= SCHEMA_VERSION) return;
  // 逐版本升级，每个版本一个事务；导入旧版本 .db 时也走这里补齐 schema。
  for (let next = version + 1; next <= SCHEMA_VERSION; next += 1) {
    await driver.exec("BEGIN");
    try {
      const migration = MIGRATIONS[next];
      if (typeof migration === "function") {
        await migration(driver);
      } else {
        for (const statement of migration.split(";").map((s) => s.trim()).filter(Boolean)) {
          await driver.exec(statement);
        }
      }
      await driver.exec(`PRAGMA user_version = ${next}`);
      await driver.exec("COMMIT");
    } catch (cause) {
      await driver.exec("ROLLBACK").catch(() => undefined);
      throw cause;
    }
  }
}

// ---- 行 ↔ 对象映射。JSON 列统一在这里编解码，可选字段 NULL 时不写键。 ----

type Row = Record<string, unknown>;

function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function parse<T>(value: unknown): T | undefined {
  return typeof value === "string" ? (JSON.parse(value) as T) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function rowToCapture(row: Row): StoredCapture {
  const capture: StoredCapture = {
    captureId: row.capture_id as string,
    url: row.url as string,
    title: (row.title as string | null) ?? "",
    intent: row.intent as StoredCapture["intent"],
    status: row.status as StoredCapture["status"],
    sourceId: (row.source_id as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    archived: Number(row.archived) === 1,
    failure: parse<StoredCapture["failure"]>(row.failure) ?? null,
  };
  const stage = text(row.stage);
  if (stage !== undefined) capture.stage = stage as StoredCapture["stage"];
  const curationNote = text(row.curation_note);
  if (curationNote !== undefined) capture.curationNote = curationNote;
  const expandLinks = parse<string[]>(row.expand_links);
  if (expandLinks !== undefined) capture.expandLinks = expandLinks;
  if (row.attempts !== null && row.attempts !== undefined && Number(row.attempts) > 0) {
    capture.attempts = Number(row.attempts);
  }
  return capture;
}

function rowToDocument(row: Row): StoredDocument {
  const doc: StoredDocument = {
    sourceId: row.source_id as string,
    url: row.url as string,
    title: (row.title as string | null) ?? "",
    platform: (row.platform as string | null) ?? "",
    contentHash: (row.content_hash as string | null) ?? "",
    parserOutput: parse<StoredDocument["parserOutput"]>(row.parser_output) as StoredDocument["parserOutput"],
    createdAt: row.created_at as string,
  };
  const curatedTitle = text(row.curated_title);
  if (curatedTitle !== undefined) doc.curatedTitle = curatedTitle;
  const summary = text(row.summary);
  if (summary !== undefined) doc.summary = summary;
  return doc;
}

function rowToCard(row: Row): StoredCard {
  return {
    cardId: row.card_id as string,
    sourceId: row.source_id as string,
    cardType: row.card_type as StoredCard["cardType"],
    title: (row.title as string | null) ?? "",
    body: (row.body as string | null) ?? "",
    domainLabels: parse<string[]>(row.domain_labels) ?? [],
    evidence: parse<StoredCard["evidence"]>(row.evidence) ?? [],
    embedding: parse<number[]>(row.embedding) ?? null,
    createdAt: row.created_at as string,
  };
}

function rowToChatTurn(row: Row): StoredChatTurn {
  return {
    queryId: row.query_id as string,
    query: row.query as string,
    turn: parse<StoredChatTurn["turn"]>(row.turn) as StoredChatTurn["turn"],
    createdAt: row.created_at as string,
  };
}

function rowToEdge(row: Row): StoredKaleidoscopeEdge {
  return {
    edgeId: row.edge_id as string,
    fromSourceId: row.from_source_id as string,
    toSourceId: row.to_source_id as string,
    relation: row.relation as string,
    strength: Number(row.strength),
    createdAt: row.created_at as string,
  };
}

function rowToChunk(row: Row): StoredChunk {
  return {
    chunkId: row.chunk_id as string,
    sourceId: row.source_id as string,
    text: row.text as string,
    blockIds: parse<string[]>(row.block_ids) ?? [],
    createdAt: row.created_at as string,
  };
}

const CAPTURE_UPSERT = `
INSERT INTO captures (capture_id, url, intent, status, stage, source_id, title,
  curation_note, expand_links, attempts, archived, failure, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(capture_id) DO UPDATE SET
  url = excluded.url, intent = excluded.intent, status = excluded.status,
  stage = excluded.stage, source_id = excluded.source_id, title = excluded.title,
  curation_note = excluded.curation_note, expand_links = excluded.expand_links,
  attempts = excluded.attempts, archived = excluded.archived, failure = excluded.failure,
  created_at = excluded.created_at, updated_at = excluded.updated_at
`;

const DOCUMENT_UPSERT = `
INSERT INTO documents (source_id, url, title, curated_title, summary, platform, content_hash, parser_output, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(source_id) DO UPDATE SET
  url = excluded.url, title = excluded.title, curated_title = excluded.curated_title,
  summary = excluded.summary, platform = excluded.platform, content_hash = excluded.content_hash,
  parser_output = excluded.parser_output, created_at = excluded.created_at
`;

const CARD_UPSERT = `
INSERT INTO cards (card_id, source_id, card_type, title, body, domain_labels, evidence, embedding, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(card_id) DO UPDATE SET
  source_id = excluded.source_id, card_type = excluded.card_type, title = excluded.title,
  body = excluded.body, domain_labels = excluded.domain_labels, evidence = excluded.evidence,
  embedding = excluded.embedding, created_at = excluded.created_at
`;

function captureParams(capture: StoredCapture): SqlValue[] {
  return [
    capture.captureId, capture.url, capture.intent ?? null, capture.status,
    capture.stage ?? null, capture.sourceId ?? null, capture.title ?? null,
    capture.curationNote ?? null, json(capture.expandLinks), capture.attempts ?? 0,
    capture.archived ? 1 : 0, json(capture.failure), capture.createdAt, capture.updatedAt,
  ];
}

function cardParams(card: StoredCard): SqlValue[] {
  return [
    card.cardId, card.sourceId, card.cardType ?? null, card.title ?? null, card.body ?? null,
    json(card.domainLabels), json(card.evidence), json(card.embedding), card.createdAt,
  ];
}

/**
 * TuntaStore 的 SQL 实现主体。运行环境无关：
 * 生产在 offscreen worker（sqlite-wasm + OPFS），契约测试在 node:sqlite。
 */
export class SqlCore implements TuntaStore {
  private readonly ready: Promise<void>;

  constructor(private readonly driver: SqlDriver) {
    this.ready = initSchema(driver);
  }

  private async run(sql: string, params?: SqlValue[]): Promise<void> {
    await this.ready;
    await this.driver.exec(sql, params);
  }

  private async rows(sql: string, params?: SqlValue[]): Promise<Row[]> {
    await this.ready;
    return this.driver.query(sql, params);
  }

  /** 多语句写事务。worker 内单连接串行执行，不会交叉。 */
  private async inTransaction(run: () => Promise<void>): Promise<void> {
    await this.ready;
    await this.driver.exec("BEGIN");
    try {
      await run();
      await this.driver.exec("COMMIT");
    } catch (cause) {
      await this.driver.exec("ROLLBACK").catch(() => undefined);
      throw cause;
    }
  }

  // captures

  async putCapture(capture: StoredCapture): Promise<StoredCapture> {
    await this.run(CAPTURE_UPSERT, captureParams(capture));
    return capture;
  }

  async getCapture(captureId: string): Promise<StoredCapture | undefined> {
    const rows = await this.rows("SELECT * FROM captures WHERE capture_id = ?", [captureId]);
    return rows[0] ? rowToCapture(rows[0]) : undefined;
  }

  async getCaptureByUrl(url: string): Promise<StoredCapture | undefined> {
    const rows = await this.rows("SELECT * FROM captures WHERE url = ?", [url]);
    return rows[0] ? rowToCapture(rows[0]) : undefined;
  }

  async listCaptures(): Promise<StoredCapture[]> {
    const rows = await this.rows("SELECT * FROM captures ORDER BY created_at DESC");
    return rows.map(rowToCapture);
  }

  // documents

  async putDocument(doc: StoredDocument): Promise<StoredDocument> {
    await this.run(DOCUMENT_UPSERT, [
      doc.sourceId, doc.url, doc.title, doc.curatedTitle ?? null, doc.summary ?? null,
      doc.platform, doc.contentHash, json(doc.parserOutput) as string, doc.createdAt,
    ]);
    return doc;
  }

  async getDocument(sourceId: string): Promise<StoredDocument | undefined> {
    const rows = await this.rows("SELECT * FROM documents WHERE source_id = ?", [sourceId]);
    return rows[0] ? rowToDocument(rows[0]) : undefined;
  }

  async listDocuments(): Promise<StoredDocument[]> {
    return (await this.rows("SELECT * FROM documents")).map(rowToDocument);
  }

  // cards

  /** 写入/更新单张卡同时维护 FTS 行（rowid 对齐 cards.rowid），只在事务内调用。 */
  private async upsertCardWithFts(card: StoredCard): Promise<void> {
    await this.driver.exec(CARD_UPSERT, cardParams(card));
    const rows = await this.driver.query("SELECT rowid FROM cards WHERE card_id = ?", [card.cardId]);
    const rowid = Number(rows[0]?.rowid);
    await this.driver.exec("DELETE FROM cards_fts WHERE rowid = ?", [rowid]);
    await this.driver.exec("INSERT INTO cards_fts (rowid, fts_text) VALUES (?, ?)", [
      rowid,
      tokenize(cardFtsText(card)).join(" "),
    ]);
  }

  async putCards(cards: StoredCard[]): Promise<void> {
    if (cards.length === 0) return;
    await this.inTransaction(async () => {
      for (const card of cards) await this.upsertCardWithFts(card);
    });
  }

  async replaceCardsForSource(sourceId: string, cards: StoredCard[]): Promise<void> {
    if (cards.some((card) => card.sourceId !== sourceId)) {
      throw new Error(`replaceCardsForSource 收到跨 source 卡片：${sourceId}`);
    }
    await this.inTransaction(async () => {
      // 先清 FTS 再删卡：rowid 子查询依赖 cards 行还在
      await this.driver.exec("DELETE FROM cards_fts WHERE rowid IN (SELECT rowid FROM cards WHERE source_id = ?)", [sourceId]);
      await this.driver.exec("DELETE FROM cards WHERE source_id = ?", [sourceId]);
      for (const card of cards) await this.upsertCardWithFts(card);
    });
  }

  async putCard(card: StoredCard): Promise<StoredCard> {
    await this.inTransaction(async () => {
      await this.upsertCardWithFts(card);
    });
    return card;
  }

  async listCards(): Promise<StoredCard[]> {
    return (await this.rows("SELECT * FROM cards")).map(rowToCard);
  }

  async listCardsBySource(sourceId: string): Promise<StoredCard[]> {
    return (await this.rows("SELECT * FROM cards WHERE source_id = ?", [sourceId])).map(rowToCard);
  }

  async searchCardsFts(query: string, limit: number): Promise<CardFtsHit[]> {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    // OR 连接：MATCH 的隐式空格是 AND，长 query 的跨词 bigram 会把结果集清零；
    // 召回语义对齐旧 ftsScore（命中任一词即入选），排序交给 bm25。
    const match = [...new Set(tokens)].map((token) => `"${token}"`).join(" OR ");
    const rows = await this.rows(
      `SELECT c.card_id, -bm25(cards_fts) AS score
       FROM cards_fts JOIN cards c ON c.rowid = cards_fts.rowid
       WHERE cards_fts MATCH ? ORDER BY bm25(cards_fts) LIMIT ?`,
      [match, limit],
    );
    return rows.map((row) => ({ cardId: row.card_id as string, score: Number(row.score) }));
  }

  // chunks（计划 §Task2.3）

  async replaceChunksForSource(sourceId: string, chunks: StoredChunk[]): Promise<void> {
    if (chunks.some((chunk) => chunk.sourceId !== sourceId)) {
      throw new Error(`replaceChunksForSource 收到跨 source chunk：${sourceId}`);
    }
    await this.inTransaction(async () => {
      await this.driver.exec("DELETE FROM chunks WHERE source_id = ?", [sourceId]);
      for (const chunk of chunks) {
        await this.driver.exec(
          "INSERT INTO chunks (chunk_id, source_id, text, block_ids, created_at) VALUES (?, ?, ?, ?, ?)",
          [chunk.chunkId, chunk.sourceId, chunk.text, json(chunk.blockIds) as string, chunk.createdAt],
        );
      }
    });
  }

  async listChunksBySource(sourceId: string): Promise<StoredChunk[]> {
    return (await this.rows("SELECT * FROM chunks WHERE source_id = ?", [sourceId])).map(rowToChunk);
  }

  // embeddings

  /** BLOB 读回是 Uint8Array；字节偏移非 4 对齐时拷一份（Float32Array 视图要求对齐）。 */
  private static blobToVector(value: unknown): Float32Array {
    const bytes = value as Uint8Array;
    if (bytes.byteOffset % 4 !== 0) {
      return new Float32Array(bytes.slice().buffer);
    }
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }

  async putEmbeddings(embeddings: StoredEmbedding[]): Promise<void> {
    if (embeddings.length === 0) return;
    await this.inTransaction(async () => {
      for (const item of embeddings) {
        const normalized = l2Normalize(item.vector);
        await this.driver.exec(
          `INSERT INTO embeddings (owner_kind, owner_id, model, dim, vector, created_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(owner_kind, owner_id, model) DO UPDATE SET
             dim = excluded.dim, vector = excluded.vector, created_at = excluded.created_at`,
          [item.ownerKind, item.ownerId, item.model, normalized.length,
           new Uint8Array(normalized.buffer), item.createdAt],
        );
      }
    });
  }

  async searchEmbeddings(queryVector: number[], model: string, topK: number, ownerKind?: StoredEmbedding["ownerKind"]): Promise<EmbeddingHit[]> {
    if (queryVector.length === 0) return [];
    // 入库向量已归一化，只归一化查询向量；点积在 worker 内 JS 暴力扫，向量不过 RPC。
    const query = l2Normalize(queryVector);
    const rows = await this.rows(
      `SELECT owner_kind, owner_id, vector FROM embeddings
       WHERE model = ? AND dim = ?${ownerKind !== undefined ? " AND owner_kind = ?" : ""}`,
      ownerKind !== undefined ? [model, query.length, ownerKind] : [model, query.length],
    );
    return rows
      .map((row) => ({
        ownerKind: row.owner_kind as StoredEmbedding["ownerKind"],
        ownerId: row.owner_id as string,
        score: dotProduct(query, SqlCore.blobToVector(row.vector)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async listEmbeddingModels(): Promise<EmbeddingModelInfo[]> {
    const rows = await this.rows(
      "SELECT model, dim, COUNT(*) AS count FROM embeddings GROUP BY model, dim ORDER BY model, dim",
    );
    return rows.map((row) => ({ model: row.model as string, dim: Number(row.dim), count: Number(row.count) }));
  }

  async listEmbeddedOwnerIds(ownerKind: StoredEmbedding["ownerKind"], model: string): Promise<string[]> {
    const rows = await this.rows("SELECT owner_id FROM embeddings WHERE owner_kind = ? AND model = ?", [ownerKind, model]);
    return rows.map((row) => row.owner_id as string);
  }

  async deleteEmbeddings(ownerKind: StoredEmbedding["ownerKind"], ownerIds: string[]): Promise<void> {
    if (ownerIds.length === 0) return;
    const placeholders = ownerIds.map(() => "?").join(", ");
    await this.run(`DELETE FROM embeddings WHERE owner_kind = ? AND owner_id IN (${placeholders})`, [
      ownerKind,
      ...ownerIds,
    ]);
  }

  // chat history

  async putChatTurn(record: StoredChatTurn): Promise<StoredChatTurn> {
    await this.run(
      `INSERT INTO chat_history (query_id, query, turn, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(query_id) DO UPDATE SET query = excluded.query, turn = excluded.turn, created_at = excluded.created_at`,
      [record.queryId, record.query, json(record.turn) as string, record.createdAt],
    );
    return record;
  }

  async getChatTurnRecord(queryId: string): Promise<StoredChatTurn | undefined> {
    const rows = await this.rows("SELECT * FROM chat_history WHERE query_id = ?", [queryId]);
    return rows[0] ? rowToChatTurn(rows[0]) : undefined;
  }

  async listChatTurns(): Promise<StoredChatTurn[]> {
    const rows = await this.rows("SELECT * FROM chat_history ORDER BY created_at DESC");
    return rows.map(rowToChatTurn);
  }

  async pruneChatTurns(keep = CHAT_HISTORY_LIMIT): Promise<void> {
    await this.run(
      `DELETE FROM chat_history WHERE query_id NOT IN (
         SELECT query_id FROM chat_history ORDER BY created_at DESC LIMIT ?)`,
      [keep],
    );
  }

  // kaleidoscope edges

  async putKaleidoscopeEdges(edges: StoredKaleidoscopeEdge[]): Promise<void> {
    if (edges.length === 0) return;
    await this.inTransaction(async () => {
      for (const edge of edges) {
        await this.driver.exec(
          `INSERT INTO kaleidoscope_edges (edge_id, from_source_id, to_source_id, relation, strength, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(edge_id) DO UPDATE SET from_source_id = excluded.from_source_id,
             to_source_id = excluded.to_source_id, relation = excluded.relation,
             strength = excluded.strength, created_at = excluded.created_at`,
          [edge.edgeId, edge.fromSourceId, edge.toSourceId, edge.relation, edge.strength, edge.createdAt],
        );
      }
    });
  }

  async listKaleidoscopeEdges(): Promise<StoredKaleidoscopeEdge[]> {
    return (await this.rows("SELECT * FROM kaleidoscope_edges")).map(rowToEdge);
  }

  async clearKaleidoscopeEdges(): Promise<void> {
    await this.run("DELETE FROM kaleidoscope_edges");
  }

  async deleteKaleidoscopeEdgesForSource(sourceId: string): Promise<void> {
    await this.run("DELETE FROM kaleidoscope_edges WHERE from_source_id = ? OR to_source_id = ?", [sourceId, sourceId]);
  }

  // maintenance

  async clearAllLocalData(): Promise<void> {
    await this.inTransaction(async () => {
      await this.driver.exec("DELETE FROM cards_fts");
      await this.driver.exec("DELETE FROM embeddings");
      await this.driver.exec("DELETE FROM chunks");
      await this.driver.exec("DELETE FROM cards");
      await this.driver.exec("DELETE FROM card_states");
      await this.driver.exec("DELETE FROM chat_history");
      await this.driver.exec("DELETE FROM kaleidoscope_edges");
      await this.driver.exec("DELETE FROM documents");
      await this.driver.exec("DELETE FROM captures");
    });
  }
}

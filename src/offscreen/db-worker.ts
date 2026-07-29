// 全扩展唯一能拿到 OPFS 同步访问句柄的地方（dedicated worker）。
// SqlCore（TuntaStore 的 SQL 实现）跑在 worker 内部，
// 通过 Comlink 整体暴露：每个 TuntaStore 方法恰好一次 worker 往返。
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import * as Comlink from "comlink";
import { SqlCore, type SqlDriver } from "@/local/store/sql-core";

const sqlite3 = await sqlite3InitModule();
// SAHPool VFS 不依赖 SharedArrayBuffer/COOP/COEP，是扩展环境下推荐的 OPFS VFS。
const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: "tunta" });

function openDb() {
  const db = new poolUtil.OpfsSAHPoolDb("/tunta.db");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

let db = openDb();

// driver 闭包引用 let db：导入后重开数据库，SqlCore 不需重建引用链。
const driver: SqlDriver = {
  async exec(sql, params = []) {
    db.exec({ sql, ...(params.length > 0 ? { bind: params } : {}) });
  },
  async query(sql, params = []) {
    const rows: Record<string, unknown>[] = [];
    db.exec({ sql, ...(params.length > 0 ? { bind: params } : {}), rowMode: "object", resultRows: rows as never });
    return rows;
  },
};

let core = new SqlCore(driver);

const host = {
  get store() {
    return core;
  },
  /** 整库字节快照（sqlite3_serialize），无需 checkpoint。 */
  async exportDb(): Promise<Uint8Array> {
    return sqlite3.capi.sqlite3_js_db_export(db);
  },
  /** 覆盖恢复：关库 → 写入字节 → 重开。重建 SqlCore 以重跑 schema 版本检查。 */
  async importDb(bytes: Uint8Array): Promise<void> {
    db.close();
    try {
      await poolUtil.importDb("/tunta.db", bytes);
    } finally {
      db = openDb();
      core = new SqlCore(driver);
    }
  },
};

export type DbWorkerHost = typeof host;

Comlink.expose(host);

// 全扩展唯一能拿到 OPFS 同步访问句柄的地方（dedicated worker）。
// SqlCore（TuntaStore 的 SQL 实现）跑在 worker 内部，
// 通过 Comlink 整体暴露：每个 TuntaStore 方法恰好一次 worker 往返。
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import * as Comlink from "comlink";
import { SqlCore, type SqlDriver } from "@/local/store/sql-core";

// 初始化是异步的（wasm 加载几百 ms），但 Comlink.expose 必须在模块求值的同步阶段完成：
// dedicated worker 的消息端口在同步求值结束后立即开始派发，top-level await 期间到达的
// RPC 会被直接丢弃，调用方永远 pending（迁移无声挂起的根因）。所有方法先 await ctxPromise。
async function init() {
  const sqlite3 = await sqlite3InitModule();
  // SAHPool VFS 不依赖 SharedArrayBuffer/COOP/COEP，是扩展环境下推荐的 OPFS VFS。
  const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: "tunta" });
  const open = () => {
    const db = new poolUtil.OpfsSAHPoolDb("/tunta.db");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    return db;
  };
  return { sqlite3, poolUtil, open, db: open() };
}

const ctxPromise = init();
ctxPromise.catch((cause) => console.error("[tunta] SQLite worker 初始化失败:", cause));

// driver 每次调用都取 ctx.db：导入后重开数据库，SqlCore 不需重建引用链。
const driver: SqlDriver = {
  async exec(sql, params = []) {
    const { db } = await ctxPromise;
    db.exec({ sql, ...(params.length > 0 ? { bind: params } : {}) });
  },
  async query(sql, params = []) {
    const { db } = await ctxPromise;
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
    const { sqlite3, db } = await ctxPromise;
    return sqlite3.capi.sqlite3_js_db_export(db);
  },
  /** 覆盖恢复：关库 → 写入字节 → 重开。重建 SqlCore 以重跑 schema 版本检查。 */
  async importDb(bytes: Uint8Array): Promise<void> {
    const ctx = await ctxPromise;
    ctx.db.close();
    try {
      await ctx.poolUtil.importDb("/tunta.db", bytes);
    } finally {
      ctx.db = ctx.open();
      core = new SqlCore(driver);
    }
  },
};

export type DbWorkerHost = typeof host;

Comlink.expose(host);

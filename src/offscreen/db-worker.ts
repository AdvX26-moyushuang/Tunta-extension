// 全扩展唯一能拿到 OPFS 同步访问句柄的地方（dedicated worker）。
// SqlCore（TuntaStore 的 SQL 实现）跑在 worker 内部，
// 通过 Comlink 整体暴露：每个 TuntaStore 方法恰好一次 worker 往返。
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import * as Comlink from "comlink";
import { SqlCore, type SqlDriver } from "@/local/store/sql-core";

const sqlite3 = await sqlite3InitModule();
// SAHPool VFS 不依赖 SharedArrayBuffer/COOP/COEP，是扩展环境下推荐的 OPFS VFS。
const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: "tunta" });
const db = new poolUtil.OpfsSAHPoolDb("/tunta.db");
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

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

Comlink.expose(new SqlCore(driver));

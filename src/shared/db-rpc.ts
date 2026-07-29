// SW ↔ offscreen 的 DB RPC 消息约定。SW 侧 SqliteStore 发起，offscreen 转发给 worker。
import type { TuntaStore } from "@/local/store/types";

export const DB_RPC_TARGET = "tunta-db" as const;

export type DbMethod = keyof TuntaStore;

export interface DbRpcRequest {
  target: typeof DB_RPC_TARGET;
  method: DbMethod;
  args: unknown[];
}

export type DbRpcResponse = { ok: true; value: unknown } | { ok: false; error: string };

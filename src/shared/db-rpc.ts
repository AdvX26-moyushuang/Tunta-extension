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

// 导出/导入 .db（计划 §Task1.5）。字节走 base64——chrome.runtime 消息只能传 JSON。
export const DB_ADMIN_TARGET = "tunta-db-admin" as const;

export type DbAdminRequest =
  | { target: typeof DB_ADMIN_TARGET; op: "export" }
  | { target: typeof DB_ADMIN_TARGET; op: "import"; payload: string };

/** export 的 value 是 base64 字符串；import 的 value 为 null。 */
export type DbAdminResponse = DbRpcResponse;

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

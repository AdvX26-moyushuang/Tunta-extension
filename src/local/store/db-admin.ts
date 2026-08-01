import { ensureOffscreen } from "@/offscreen/host";
import {
  base64ToBytes,
  bytesToBase64,
  DB_ADMIN_TARGET,
  type DbAdminRequest,
  type DbAdminResponse,
} from "@/shared/db-rpc";

/**
 * 导出/导入 .db（计划 §Task1.5）。
 * OPFS 对用户完全不可见，local-first 产品必须给用户一条把数据拿走的路。
 * 与 SqliteStore 同款链路：ensureOffscreen → chrome.runtime 消息 → offscreen → worker。
 */
async function callAdmin(request: DbAdminRequest): Promise<unknown> {
  await ensureOffscreen();
  const response = (await chrome.runtime.sendMessage(request)) as DbAdminResponse | undefined;
  if (!response) throw new Error(`tunta-db-admin RPC 无响应：${request.op}`);
  if (!response.ok) throw new Error(response.error);
  return response.value;
}

/** 整库字节快照，调用方负责落成下载文件。 */
export async function exportDbBytes(): Promise<Uint8Array> {
  const base64 = (await callAdmin({ target: DB_ADMIN_TARGET, op: "export" })) as string;
  return base64ToBytes(base64);
}

/** 覆盖恢复。只动 SQLite（OPFS），不碰 IndexedDB（硬规则 1）。 */
export async function importDbBytes(bytes: Uint8Array): Promise<void> {
  await callAdmin({ target: DB_ADMIN_TARGET, op: "import", payload: bytesToBase64(bytes) });
}

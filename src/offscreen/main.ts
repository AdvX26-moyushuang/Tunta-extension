// 全扩展唯一的 offscreen 文档入口。
// 硬规则 2：整个扩展生命周期内只能有一个 offscreen document，
// Phase 4 的 Readability / pdf.js 也必须挂在这里，不要另建。
import * as Comlink from "comlink";
import { DB_RPC_TARGET, type DbRpcRequest, type DbRpcResponse } from "@/shared/db-rpc";
import type { TuntaStore } from "@/local/store/types";

const worker = new Worker(new URL("./db-worker.ts", import.meta.url), { type: "module" });
const core = Comlink.wrap<TuntaStore>(worker);

// SW → offscreen 走 chrome.runtime 消息（MessagePort 传不过扩展消息通道），
// offscreen → worker 走 Comlink。每个 TuntaStore 方法一次往返。
chrome.runtime.onMessage.addListener((raw: DbRpcRequest, _sender, sendResponse: (r: DbRpcResponse) => void) => {
  if (raw?.target !== DB_RPC_TARGET) return;
  void (async () => {
    try {
      const method = core[raw.method] as unknown as (...args: unknown[]) => Promise<unknown>;
      const value = await method.apply(core, raw.args ?? []);
      sendResponse({ ok: true, value });
    } catch (cause) {
      sendResponse({ ok: false, error: cause instanceof Error ? cause.message : String(cause) });
    }
  })();
  return true; // 异步 sendResponse
});

console.info("[tunta] offscreen 宿主已就绪");

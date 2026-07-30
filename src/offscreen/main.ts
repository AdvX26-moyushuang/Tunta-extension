// 全扩展唯一的 offscreen 文档入口。
// 硬规则 2：整个扩展生命周期内只能有一个 offscreen document，
// Phase 4 的 Readability / pdf.js 也必须挂在这里，不要另建。
import * as Comlink from "comlink";
import {
  base64ToBytes,
  bytesToBase64,
  DB_ADMIN_TARGET,
  DB_RPC_TARGET,
  type DbAdminRequest,
  type DbMethod,
  type DbRpcRequest,
  type DbRpcResponse,
} from "@/shared/db-rpc";
import {
  PARSE_RPC_TARGET,
  type ArticleParseResponse,
  type ParseRpcRequest,
  type PdfParseResponse,
} from "@/shared/parse-rpc";
import type { DbWorkerHost } from "./db-worker";
import { parseArticleHtml } from "./readability";
import { parsePdf } from "./pdf";

const worker = new Worker(new URL("./db-worker.ts", import.meta.url), { type: "module" });
worker.addEventListener("error", (event) => {
  console.error("[tunta] db-worker 崩溃:", event.message);
});
const remote = Comlink.wrap<DbWorkerHost>(worker);
// Comlink 的 path proxy 支持 remote.store.method(...) 链式调用，但 Remote<T> 把 getter
// 映射成 Promise，无法直接索引；这里断言成可调用面，运行时语义不变。
const storeRemote = remote.store as unknown as Record<DbMethod, (...args: unknown[]) => Promise<unknown>>;

// SW → offscreen 走 chrome.runtime 消息（MessagePort 传不过扩展消息通道），
// offscreen → worker 走 Comlink。每个 TuntaStore 方法一次往返。
chrome.runtime.onMessage.addListener(
  (raw: DbRpcRequest | DbAdminRequest | ParseRpcRequest, _sender, sendResponse: (r: DbRpcResponse | ArticleParseResponse | PdfParseResponse) => void) => {
    if (raw?.target === DB_RPC_TARGET) {
      void (async () => {
        try {
          const value = await storeRemote[raw.method](...(raw.args ?? []));
          sendResponse({ ok: true, value });
        } catch (cause) {
          sendResponse({ ok: false, error: cause instanceof Error ? cause.message : String(cause) });
        }
      })();
      return true; // 异步 sendResponse
    }

    if (raw?.target === DB_ADMIN_TARGET) {
      void (async () => {
        try {
          if (raw.op === "export") {
            const bytes = await remote.exportDb();
            sendResponse({ ok: true, value: bytesToBase64(bytes) });
          } else {
            await remote.importDb(base64ToBytes(raw.payload));
            sendResponse({ ok: true, value: null });
          }
        } catch (cause) {
          sendResponse({ ok: false, error: cause instanceof Error ? cause.message : String(cause) });
        }
      })();
      return true;
    }

    // 正文/PDF 解析（计划 §Task4.1/4.2）：SW 没有 DOMParser，Readability/pdfjs 集中在这里跑
    if (raw?.target === PARSE_RPC_TARGET) {
      void (async () => {
        try {
          if (raw.op === "pdf") {
            sendResponse({ ok: true, value: await parsePdf(raw.data) });
          } else {
            sendResponse({ ok: true, value: parseArticleHtml(raw.html, raw.url) });
          }
        } catch (cause) {
          sendResponse({ ok: false, error: cause instanceof Error ? cause.message : String(cause) });
        }
      })();
      return true;
    }

    return undefined;
  },
);

console.info("[tunta] offscreen 宿主已就绪");

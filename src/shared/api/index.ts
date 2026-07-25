/**
 * API client 工厂。
 *
 * 三种模式（VITE_TUNTA_API_MODE 切换）：
 * - local（默认）：插件独立模式——抓取 / 存储 / 卡片 / 检索 / 问答全部在扩展内
 *   完成（IndexedDB + 用户配置的 provider），不安装 helper 也有完整 MVP 体验
 * - real：直连 backend helper（VITE_TUNTA_API_BASE，默认 http://127.0.0.1:4318）
 * - mock：contracts fixtures + 内存收藏库，用于纯网页预览与 UI 开发
 */
import { createLocalApi } from "@/local/api";
import { createMockApi } from "@/mock/mock";
import { createRealApi, type TuntaApi } from "./client";

export type ApiMode = "real" | "mock" | "local";

function resolveMode(): ApiMode {
  const raw = import.meta.env.VITE_TUNTA_API_MODE;
  return raw === "real" || raw === "mock" || raw === "local" ? raw : "local";
}

export const API_MODE: ApiMode = resolveMode();

export const API_BASE: string = import.meta.env.VITE_TUNTA_API_BASE ?? "http://127.0.0.1:4318";

let instance: TuntaApi | null = null;

export function getApi(): TuntaApi {
  if (!instance) {
    instance =
      API_MODE === "real" ? createRealApi(API_BASE) : API_MODE === "mock" ? createMockApi() : createLocalApi();
  }
  return instance;
}

export * from "./client";
export type * from "./contracts";

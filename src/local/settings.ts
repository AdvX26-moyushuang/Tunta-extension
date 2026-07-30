import { isExtensionContext } from "@/shared/browser";
import { DEFAULT_RETRIEVAL_WEIGHTS, type RetrievalWeights } from "./retrieve";

export interface ChatProviderConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface EmbeddingProviderConfig {
  // 未启用时,退化为纯FTS
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface OcrConfig {
  /** 图片会离开本机发给 chat provider：必须显式 opt-in，默认关闭（计划 §Task4.3）。 */
  enabled: boolean;
}

export interface LocalSettings {
  chat: ChatProviderConfig;
  embedding: EmbeddingProviderConfig;
  /** 加权 RRF 的通道权重（计划 §Task2.4），存量设置缺失时落默认值。 */
  retrieval: RetrievalWeights;
  ocr: OcrConfig;
}

const STORAGE_KEY = "tunta:local-settings";

export const DEFAULT_SETTINGS: LocalSettings = {
  chat: {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/anthropic",
    model: "deepseek-v4-flash",
    apiKey: "",
  },
  embedding: {
    enabled: false,
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "BAAI/bge-m3",
    apiKey: "",
  },
  retrieval: DEFAULT_RETRIEVAL_WEIGHTS,
  ocr: { enabled: false },
};

function mergeWithDefaults(raw: Partial<LocalSettings> | null | undefined): LocalSettings {
  return {
    chat: { ...DEFAULT_SETTINGS.chat, ...(raw?.chat ?? {}) },
    embedding: { ...DEFAULT_SETTINGS.embedding, ...(raw?.embedding ?? {}) },
    retrieval: { ...DEFAULT_SETTINGS.retrieval, ...(raw?.retrieval ?? {}) },
    ocr: { ...DEFAULT_SETTINGS.ocr, ...(raw?.ocr ?? {}) },
  };
}

export async function loadSettings(): Promise<LocalSettings> {
  if (isExtensionContext() && chrome.storage?.local) {
    const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    return mergeWithDefaults(stored as Partial<LocalSettings> | undefined);
  }
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return mergeWithDefaults(raw ? (JSON.parse(raw) as Partial<LocalSettings>) : null);
  } catch {
    return mergeWithDefaults(null);
  }
}

export async function saveSettings(settings: LocalSettings): Promise<void> {
  if (isExtensionContext() && chrome.storage?.local) {
    await chrome.storage.local.set({ [STORAGE_KEY]: settings });
    return;
  }
  globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function isChatConfigured(settings: LocalSettings): boolean {
  return Boolean(settings.chat.apiKey.trim()) && Boolean(settings.chat.baseUrl.trim());
}

export function isEmbeddingConfigured(settings: LocalSettings): boolean {
  return (
    settings.embedding.enabled &&
    Boolean(settings.embedding.apiKey.trim()) &&
    Boolean(settings.embedding.baseUrl.trim())
  );
}

export async function ensureOriginPermission(url: string): Promise<boolean> {
  if (!isExtensionContext() || !chrome.permissions?.request) return true;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  const pattern = `${origin}/*`;
  const already = await chrome.permissions.contains({ origins: [pattern] });
  if (already) return true;
  return chrome.permissions.request({ origins: [pattern] });
}

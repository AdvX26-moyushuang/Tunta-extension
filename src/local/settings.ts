import { isExtensionContext } from "@/shared/browser";

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

export interface LocalSettings {
  chat: ChatProviderConfig;
  embedding: EmbeddingProviderConfig;
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
};

function mergeWithDefaults(raw: Partial<LocalSettings> | null | undefined): LocalSettings {
  return {
    chat: { ...DEFAULT_SETTINGS.chat, ...(raw?.chat ?? {}) },
    embedding: { ...DEFAULT_SETTINGS.embedding, ...(raw?.embedding ?? {}) },
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

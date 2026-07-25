/**
 * chrome.* 扩展 API 的轻量封装。
 *
 * 目标浏览器是 Chrome / Edge（MV3）。在非扩展上下文（如 vite dev 的纯网页预览）
 * 中调用这些 API 会直接抛错，调用方需要能容忍失败并回退到输入态。
 */

export function isExtensionContext(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
}

export async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  if (!isExtensionContext()) return null;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

/** 读取当前标签页 URL；非 http(s) 页面（chrome:// 等）返回 null。 */
export async function getActiveTabUrl(): Promise<string | null> {
  const tab = await getActiveTab();
  const url = tab?.url ?? null;
  if (!url || !/^https?:\/\//.test(url)) return null;
  return url;
}

export async function readClipboardText(): Promise<string> {
  return navigator.clipboard.readText();
}

export async function openWorkspace(): Promise<void> {
  if (!isExtensionContext()) return;
  await chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
}

export async function openExternal(url: string): Promise<void> {
  if (isExtensionContext()) {
    await chrome.tabs.create({ url });
    return;
  }
  window.open(url, "_blank", "noopener");
}

// SW 侧调用。必须每次调用前 ensure，因为 offscreen 可能已被浏览器回收。
export async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType] });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["WORKERS" as chrome.offscreen.Reason],
    justification: "本地 SQLite 数据库需要 OPFS 同步访问句柄，只能在 dedicated worker 中获得。",
  });
}

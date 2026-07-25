import { useCallback, useEffect, useState } from "react";
import { API_MODE, getApi } from "@/shared/api";
import type { CaptureIntent, PageSnapshot } from "@/shared/api/contracts";
import { isValidUrl, normalizeUrl } from "@/shared/format";
import { getActiveTab, getActiveTabUrl, openWorkspace, readClipboardText } from "@/shared/browser";
import { StatusChip } from "@/shared/components/StatusChip";
import { useCaptureTracking } from "@/shared/useCaptureTracking";
import { sendMessage } from "@/shared/messages";
import { executeSnapshotOnTab } from "@/local/snapshot";
import tuntaIconUrl from "../../assets/icon.png";


export function App() {
  const [url, setUrl] = useState("");
  const [intent, setIntent] = useState<CaptureIntent>("pending");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { tracked, track } = useCaptureTracking();

  
  useEffect(() => {
    void getActiveTabUrl().then((tabUrl) => {
      if (tabUrl) setUrl(tabUrl);
    });
  }, []);

  const pasteClipboard = useCallback(async () => {
    setError(null);
    try {
      const text = (await readClipboardText()).trim();
      if (!isValidUrl(text)) {
        setError("剪贴板不是 URL：请先复制有效链接。");
        return;
      }
      setUrl(text);
    } catch {
      setError("无法读取剪贴板，请手动粘贴。");
    }
  }, []);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const value = url.trim();
      setError(null);
      setNotice(null);
      if (!isValidUrl(value)) {
        setError("不是有效链接：请输入 http(s) URL。");
        return;
      }
      setBusy(true);
      try {
        
        const tab = await getActiveTab();
        const isCurrentTab =
          tab?.id != null && tab.url != null && normalizeUrl(tab.url) === normalizeUrl(value) ? tab.id : undefined;

          
        let snapshot: PageSnapshot | undefined;
        if (isCurrentTab != null && API_MODE === "local") {
          setNotice("正在读取当前页面…");
          const data = await executeSnapshotOnTab(isCurrentTab, value);
          snapshot = {
            finalUrl: data.finalUrl,
            title: data.title,
            platform: data.platform,
            contentType: data.contentType,
            blocks: data.blocks,
            ...(data.author ? { author: data.author } : {}),
            ...(data.publishedAt ? { publishedAt: data.publishedAt } : {}),
            ...(data.listLinks?.length ? { listLinks: data.listLinks } : {}),
            ...(data.degradedNote ? { degradedNote: data.degradedNote } : {}),
            ...(data.warnings.length ? { warnings: data.warnings } : {}),
          };
        }

        const result = await getApi().submitCapture({ url: value, intent }, { tabId: isCurrentTab, snapshot });
        track(result.capture);
        sendMessage({ type: "tunta:capture-submitted", captureId: result.capture.captureId });
        setNotice(
          result.duplicate
            ? "URL 已在收藏库中，以下是现有记录。"
            : snapshot
              ? snapshot.listLinks?.length
                ? `已收藏列表页：检测到 ${snapshot.listLinks.length} 个子项目，后台逐条抓取。`
                : "已收藏当前页面快照，后台开始生成卡片。"
              : "已收藏，后台开始抓取解析。",
        );
      } catch (cause) {
        setError(`收藏失败：${cause instanceof Error ? cause.message : String(cause)}`);
      } finally {
        setBusy(false);
      }
    },
    [url, intent, track],
  );

  return (
    <div className="popup">
      <header className="popup-head">
        <div className="popup-title">
          <img className="popup-logo" src={tuntaIconUrl} alt="" />
          <div>
            <span className="eyebrow">收藏当前页面</span>
            <strong>收藏到 Tunta</strong>
          </div>
        </div>
      </header>

      <form className="popup-body" onSubmit={submit}>
        <div>
          <label className="field-label" htmlFor="capture-url">
            URL（当前页面或粘贴板）
          </label>
          <div className="url-row">
            <input
              id="capture-url"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://…"
              autoComplete="off"
            />
            <button type="button" onClick={() => void pasteClipboard()}>
              读剪贴板
            </button>
          </div>
        </div>

        <div>
          <span className="field-label">收藏意图</span>
          <div className="intent-group" role="radiogroup" aria-label="收藏意图">
            <label className={`intent-option ${intent === "pending" ? "active" : ""}`}>
              <input
                type="radio"
                name="intent"
                value="pending"
                checked={intent === "pending"}
                onChange={() => setIntent("pending")}
              />
              <span>
                <strong>待消化</strong>
                <small>进入随机回看队列，之后逐条消化。</small>
              </span>
            </label>
            <label className={`intent-option ${intent === "favorite" ? "active" : ""}`}>
              <input
                type="radio"
                name="intent"
                value="favorite"
                checked={intent === "favorite"}
                onChange={() => setIntent("favorite")}
              />
              <span>
                <strong>常用</strong>
                <small>高频复用内容，不参与默认清理。</small>
              </span>
            </label>
          </div>
        </div>

        <button type="submit" className="submit-button" disabled={busy}>
          {busy ? "提交中…" : "收藏"}
        </button>

        {error && <div className="error-text">{error}</div>}
        {notice && !error && <div className="notice-text">{notice}</div>}

        {tracked && (
          <div className="capture-status">
            <StatusChip status={tracked.status} />
            <span className="detail" title={tracked.url}>
              {tracked.title || tracked.url}
            </span>
            {tracked.status === "failed" && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void getApi()
                    .retryCapture(tracked.captureId)
                    .then(track);
                }}
              >
                重试
              </button>
            )}
          </div>
        )}
        {tracked?.status === "failed" && tracked.failure && (
          <div className="error-text">
            {tracked.failure.stage} / {tracked.failure.code}：{tracked.failure.message}
          </div>
        )}
      </form>

      <footer className="popup-foot">
        <span>{API_MODE === "local" ? "本地模式" : API_MODE === "mock" ? "样例数据" : "连接后端"}</span>
        <button type="button" onClick={() => void openWorkspace()}>
          打开工作台 ↗
        </button>
      </footer>
    </div>
  );
}

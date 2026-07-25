import { useCallback, useEffect, useState } from "react";
import { getApi } from "@/shared/api";
import type { BackendStatus, CaptureIntent } from "@/shared/api/contracts";
import { isValidUrl } from "@/shared/format";
import { readClipboardText } from "@/shared/browser";
import { StatusChip } from "@/shared/components/StatusChip";
import { Toast, useToast } from "@/shared/components/Toast";
import { useCaptureTracking } from "@/shared/useCaptureTracking";
import { ReviewPage } from "./pages/ReviewPage";
import { SearchPage } from "./pages/SearchPage";
import { LibraryPage } from "./pages/LibraryPage";
import { TracePage } from "./pages/TracePage";
import { KaleidoscopePage } from "./pages/KaleidoscopePage";
import { SettingsPage } from "./pages/SettingsPage";
import tuntaIconUrl from "../../assets/icon.png";

type Page = "review" | "search" | "library" | "trace" | "kaleidoscope" | "settings";

const PRIMARY_NAV: { id: Exclude<Page, "settings">; label: string }[] = [
  { id: "review", label: "随机回看" },
  { id: "search", label: "检索与问答" },
  { id: "library", label: "收藏库" },
  { id: "trace", label: "来源追溯" },
  { id: "kaleidoscope", label: "万花筒" },
];

/**
 * 导航图标：统一 24 视框、圆角线、圆弧与圆点构造——和水的语言一致，
 * 去掉编号后每个图标要能自己说清楚是哪一页。
 */
function NavIcon({ name }: { name: Page }) {
  // 随机回看：一张卡浮在水面上
  if (name === "review") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="5" y="4" width="14" height="10.5" rx="3" />
        <path d="M3.5 18.6q2.1-2.2 4.2 0t4.2 0 4.2 0 4.2 0" />
      </svg>
    );
  }
  // 检索与问答：放大镜
  if (name === "search") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="10.5" cy="10.5" r="6" />
        <path d="m15 15 4.7 4.7" />
      </svg>
    );
  }
  // 收藏库：一叠卡
  if (name === "library") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4.5" y="9" width="15" height="10.5" rx="3" />
        <path d="M6.8 6.2h10.4M9 3.6h6" />
      </svg>
    );
  }
  // 来源追溯：回到原处
  if (name === "trace") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4.5 8.5h9.5a5.75 5.75 0 0 1 0 11.5H9" />
        <path d="m8.3 4.4-3.9 4.1 3.9 4.1" />
      </svg>
    );
  }
  // 万花筒：外圈是镜筒，中心镜片向六个方向形成对称图案
  if (name === "kaleidoscope") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8.4" />
        <circle cx="12" cy="12" r="2.2" />
        <path d="M12 3.6v6.2M19.3 7.8l-5.4 3.1M19.3 16.2l-5.4-3.1M12 20.4v-6.2M4.7 16.2l5.4-3.1M4.7 7.8l5.4 3.1" />
      </svg>
    );
  }
  // 设置：三根推子，滑块处断开线条，比原来的圆圈压线更干净
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 3.6v5.2M6 12.4v8M12 3.6v9.6M12 16.8v3.6M18 3.6v2.4M18 10v10.4" />
      <path d="M3.9 10.6h4.2M9.9 15h4.2M15.9 8.2h4.2" />
    </svg>
  );
}

export function App() {
  const [page, setPage] = useState<Page>("review");
  const [status, setStatus] = useState<BackendStatus | null>(null);
  const { toast, show } = useToast();

  const refreshStatus = useCallback(() => {
    getApi()
      .getStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  useEffect(refreshStatus, [refreshStatus]);

  return (
    <div className="shell">
      <aside className="rail" aria-label="主导航">
        <div className="mark">
          <img className="mark-icon" src={tuntaIconUrl} alt="Tunta" />
        </div>
        <nav className="rail-nav">
          {PRIMARY_NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`rail-button ${page === item.id ? "active" : ""}`}
              data-label={item.label}
              aria-label={item.label}
              onClick={() => setPage(item.id)}
            >
              <NavIcon name={item.id} />
            </button>
          ))}
        </nav>
        <div className="rail-bottom">
          <nav className="rail-utility-nav" aria-label="辅助导航">
            <button
              type="button"
              className={`rail-button ${page === "settings" ? "active" : ""}`}
              data-label="设置"
              aria-label="设置"
              onClick={() => setPage("settings")}
            >
              <NavIcon name="settings" />
            </button>
          </nav>
          <div className="rail-foot" title={status ? "Backend 已连接" : "Backend 未连接"}>
            <span className={`connection-dot ${status ? "online" : ""}`} />
          </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <CaptureBar onToast={show} />
        </header>

        {page === "review" && <ReviewPage onToast={show} />}
        {page === "search" && <SearchPage onToast={show} />}
        {page === "library" && <LibraryPage onToast={show} />}
        {page === "trace" && <TracePage />}
        {page === "kaleidoscope" && <KaleidoscopePage onToast={show} />}
        {page === "settings" && <SettingsPage onToast={show} onSaved={refreshStatus} />}

        <Toast toast={toast} />
      </main>
    </div>
  );
}

/** 顶栏收藏入口：粘贴 URL 或读剪贴板，选择意图后入库，状态全程可见。 */
function CaptureBar({ onToast }: { onToast: (message: string) => void }) {
  const [url, setUrl] = useState("");
  const [intent, setIntent] = useState<CaptureIntent>("pending");
  const [busy, setBusy] = useState(false);
  const { tracked, track } = useCaptureTracking();

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const value = url.trim();
      if (!isValidUrl(value)) {
        onToast("不是有效链接：请粘贴 http(s) URL。");
        return;
      }
      setBusy(true);
      try {
        const result = await getApi().submitCapture({ url: value, intent });
        track(result.capture);
        onToast(result.duplicate ? "URL 已在收藏库中，展示现有记录。" : "已加入收藏，开始抓取解析。");
        if (!result.duplicate) setUrl("");
      } catch (error) {
        onToast(`收藏失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [url, intent, onToast, track],
  );

  const pasteClipboard = useCallback(async () => {
    try {
      const text = (await readClipboardText()).trim();
      if (!isValidUrl(text)) {
        onToast("剪贴板不是 URL：请先复制有效链接。");
        return;
      }
      setUrl(text);
    } catch {
      onToast("无法读取剪贴板，请手动粘贴。");
    }
  }, [onToast]);

  return (
    <form className="capture-bar" onSubmit={submit}>
      <input
        type="url"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="粘贴 URL 收藏：B 站视频（字幕优先）或普通网页"
        aria-label="收藏 URL"
      />
      <select value={intent} onChange={(event) => setIntent(event.target.value as CaptureIntent)} aria-label="收藏意图">
        <option value="pending">待消化</option>
        <option value="favorite">常用</option>
      </select>
      <button type="button" className="btn" onClick={() => void pasteClipboard()}>
        读剪贴板
      </button>
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy ? "提交中…" : "收藏"}
      </button>
      {tracked && (
        <div className="capture-status">
          <StatusChip status={tracked.status} />
          <span>{tracked.title || tracked.url}</span>
          {tracked.status === "failed" && tracked.failure && (
            <span className="failure">
              {tracked.failure.stage} / {tracked.failure.code}：{tracked.failure.message}
            </span>
          )}
        </div>
      )}
    </form>
  );
}

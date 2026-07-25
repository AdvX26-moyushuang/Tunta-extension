import { useCallback, useEffect, useState } from "react";
import { getApi } from "@/shared/api";
import type { CaptureIntent, CaptureItem } from "@/shared/api/contracts";
import { formatTime } from "@/shared/format";
import { StatusChip } from "@/shared/components/StatusChip";

interface LibraryPageProps {
  onToast: (message: string) => void;
}

const POLL_INTERVAL_MS = 2000;
const IN_FLIGHT = new Set(["idle", "fetching", "parsing"]);

/**
 * 收藏库：全部收藏记录与处理状态。
 * 状态可见性（REQ-009）：in-flight 记录每 2s 轮询直到进入终态。
 * 失败重试（REQ-010）：失败记录保留错误类型，可重试且不生成重复记录。
 */
export function LibraryPage({ onToast }: LibraryPageProps) {
  const [captures, setCaptures] = useState<CaptureItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await getApi().listCaptures();
      setCaptures(list);
      setLoaded(true);
      return list;
    } catch (error) {
      onToast(`收藏库加载失败：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }, [onToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 有 in-flight 记录时轮询
  useEffect(() => {
    if (!captures.some((item) => IN_FLIGHT.has(item.status))) return;
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [captures, refresh]);

  const updateIntent = useCallback(
    async (capture: CaptureItem, intent: CaptureIntent) => {
      try {
        await getApi().updateCaptureIntent(capture.captureId, intent);
        await refresh();
      } catch (error) {
        onToast(`修改意图失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [refresh, onToast],
  );

  const retry = useCallback(
    async (capture: CaptureItem) => {
      try {
        await getApi().retryCapture(capture.captureId);
        onToast("已重新加入处理队列。");
        await refresh();
      } catch (error) {
        onToast(`重试失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [refresh, onToast],
  );

  const archive = useCallback(
    async (capture: CaptureItem) => {
      if (capture.intent === "favorite" && !window.confirm("这是「常用」内容，确认归档？")) {
        return;
      }
      try {
        await getApi().archiveCapture(capture.captureId);
        onToast("已归档。");
        await refresh();
      } catch (error) {
        onToast(`归档失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [refresh, onToast],
  );

  return (
    <section className="page">
      <div className="page-head">
        <h1>Library</h1>
        <p>翻开收藏库，看清每条的来路与状态。</p>
      </div>

      <div className="page-body">
        {loaded && captures.length === 0 ? (
          <div className="empty-state">
            <div>
              <strong>收藏库是空的。</strong>
              <span>从顶栏粘贴 URL，或用浏览器插件按钮收藏当前页面。</span>
            </div>
          </div>
        ) : (
          <div className="capture-table">
            <div className="capture-row header">
              <span>标题 / 来源</span>
              <span>URL</span>
              <span>意图</span>
              <span>状态</span>
              <span>收藏时间</span>
              <span>操作</span>
            </div>
            {captures.map((capture) => (
              <div key={capture.captureId} className="capture-row">
                <div>
                  <div className="capture-title">{capture.title || "（等待解析标题）"}</div>
                  {capture.archived && <div className="capture-url">已归档</div>}
                  {capture.curationNote && <div className="capture-note">{capture.curationNote}</div>}
                </div>
                <div className="capture-url" title={capture.url}>
                  {capture.url}
                </div>
                <select
                  className="capture-intent"
                  value={capture.intent}
                  aria-label="收藏意图"
                  onChange={(event) => void updateIntent(capture, event.target.value as CaptureIntent)}
                >
                  <option value="pending">待消化</option>
                  <option value="favorite">常用</option>
                </select>
                <StatusChip status={capture.status} />
                <span className="capture-url">{formatTime(capture.createdAt)}</span>
                <div className="capture-actions">
                  {capture.status === "failed" && (
                    <button type="button" className="btn" onClick={() => void retry(capture)}>
                      重试
                    </button>
                  )}
                  {!capture.archived && (
                    <button type="button" className="btn" onClick={() => void archive(capture)}>
                      归档
                    </button>
                  )}
                </div>
                {capture.status === "failed" && capture.failure && (
                  <div className="capture-failure">
                    {capture.failure.stage} / {capture.failure.code}：{capture.failure.message}
                    {capture.failure.recoverable ? "（可重试）" : "（不可重试）"}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

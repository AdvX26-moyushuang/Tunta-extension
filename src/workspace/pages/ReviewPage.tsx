import { useCallback, useEffect, useState } from "react";
import { getApi } from "@/shared/api";
import type { ReviewItem } from "@/shared/api/contracts";
import { formatTime, hostOf } from "@/shared/format";
import { openExternal } from "@/shared/browser";

interface ReviewPageProps {
  onToast: (message: string) => void;
}

type LoadState = "loading" | "ready" | "empty";

/**
 * 回看模式（DEV.md §5.2）：随机呈现一条待消化收藏，
 * 支持查看原文、下一条、归档；选取逻辑为带去重的随机策略（backend 侧）。
 */
export function ReviewPage({ onToast }: ReviewPageProps) {
  const [state, setState] = useState<LoadState>("loading");
  const [item, setItem] = useState<ReviewItem | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [leaving, setLeaving] = useState<"left" | "right" | null>(null);

  const loadNext = useCallback(async () => {
    setState("loading");
    setLeaving(null);
    try {
      const response = await getApi().getReviewNext();
      setItem(response.item);
      setRemaining(response.remaining);
      setState(response.item ? "ready" : "empty");
    } catch (error) {
      setState("empty");
      onToast(`回看队列加载失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [onToast]);

  useEffect(() => {
    void loadNext();
  }, [loadNext]);

  const skip = useCallback(() => {
    setLeaving("left");
    window.setTimeout(() => void loadNext(), 210);
  }, [loadNext]);

  const archive = useCallback(async () => {
    if (!item) return;
    if (item.capture.intent === "favorite" && !window.confirm("这是「常用」内容，确认归档？")) {
      return;
    }
    try {
      await getApi().archiveCapture(item.capture.captureId);
      onToast("已归档。");
      setLeaving("right");
      window.setTimeout(() => void loadNext(), 210);
    } catch (error) {
      onToast(`归档失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [item, loadNext, onToast]);

  // 键盘：← 下一条，→ 归档（不在输入框聚焦时）
  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.matches("input, textarea, select")) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        skip();
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        void archive();
      }
    };
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, [skip, archive]);

  return (
    <section className="page">
      <div className="review-stage">
        {state === "ready" && item ? (
          <div className="card-stack">
            <div className="card-shadow" aria-hidden="true" />
            <article className={`knowledge-card ${leaving ? `leave-${leaving}` : ""}`}>
              <div className="card-topline">
                <span className="card-type">{item.card.cardType}</span>
                <span>
                  {hostOf(item.originalUrl)} · 收藏于 {formatTime(item.capture.createdAt)}
                </span>
              </div>
              <h1 className="card-title">{item.card.title}</h1>
              <p className="card-body">{item.card.body}</p>
              <div className="card-domain-list">
                {item.card.domainLabels.map((label) => (
                  <span key={label} className="domain-pill">
                    {label}
                  </span>
                ))}
              </div>
              <div className="evidence-strip">
                <span className="evidence-mark">↗</span>
                <div>
                  <strong>{item.card.source?.source_id ?? item.capture.sourceId ?? "unknown"}</strong>
                  <br />
                  {item.originalUrl}
                </div>
              </div>
            </article>
            <div className="card-actions">
              <button type="button" className="action-button" onClick={() => void openExternal(item.originalUrl)}>
                <span>查看原文</span>
                <span className="keycap">↗</span>
              </button>
              <button type="button" className="action-button secondary" onClick={skip}>
                <span>下一条</span>
                <span className="keycap">←</span>
              </button>
              <button type="button" className="action-button keep" onClick={() => void archive()}>
                <span>归档</span>
                <span className="keycap">→</span>
              </button>
            </div>
            <div className="review-meta">待消化剩余 {remaining} 条 · ← 下一条 · → 归档</div>
          </div>
        ) : (
          <div className="empty-card empty-state" style={{ width: "min(600px, 92%)" }}>
            <div>
              <strong>{state === "loading" ? "抽取中…" : "没有待消化的收藏。"}</strong>
              <span>
                {state === "loading"
                  ? "正在从收藏库随机抽取一条。"
                  : "从顶栏或浏览器插件收藏新内容，解析完成后会进入回看队列。"}
              </span>
              {state === "empty" && (
                <div style={{ marginTop: 18 }}>
                  <button type="button" className="btn" onClick={() => void loadNext()}>
                    重新检查
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

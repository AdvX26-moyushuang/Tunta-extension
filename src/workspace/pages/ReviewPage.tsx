import { useCallback, useEffect, useRef, useState } from "react";
import { getApi } from "@/shared/api";
import type { ReviewItem, ReviewMode } from "@/shared/api/contracts";
import { formatTime, hostOf } from "@/shared/format";
import { openExternal } from "@/shared/browser";
import { KnowledgeCard } from "@/shared/components/KnowledgeCard";

interface ReviewPageProps {
  onToast: (message: string) => void;
}

type LoadState = "loading" | "ready" | "empty";

/**
 * 回看模式（DEV.md §5.2）：随机呈现一张卡片，支持查看原文、下一条、归档。
 *
 * 两种取卡口径，用 tab 切换：
 * - New：待消化队列，一张卡消费一条收藏，「下一条」写「已看过」
 * - All：全卡库漫游，忽略已看过与归档，「下一条」只是重新随机，不消耗队列
 */
export function ReviewPage({ onToast }: ReviewPageProps) {
  const [mode, setMode] = useState<ReviewMode>("new");
  const [state, setState] = useState<LoadState>("loading");
  const [item, setItem] = useState<ReviewItem | null>(null);
  /** New 队列的待办数，切到 All 之后 tab 上仍要显示 */
  const [newCount, setNewCount] = useState(0);
  const [leaving, setLeaving] = useState<"left" | "right" | null>(null);
  const transitionTimer = useRef<number | null>(null);

  const loadNext = useCallback(
    async (target: ReviewMode) => {
      setState("loading");
      setLeaving(null);
      try {
        const response = await getApi().getReviewNext(target);
        setItem(response.item);
        if (target === "new") {
          // remaining 是「除当前这张外还剩几张」，tab 上要显示队列里的总数
          setNewCount(response.remaining + (response.item ? 1 : 0));
        }
        setState(response.item ? "ready" : "empty");
      } catch (error) {
        setItem(null);
        setState("empty");
        onToast(`回看加载失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [onToast],
  );

  useEffect(() => {
    void loadNext(mode);
  }, [loadNext, mode]);

  // New 队列的计数在 All 模式下也要保持新鲜（归档/看过都会改变它）
  useEffect(() => {
    if (mode !== "all") return;
    void getApi()
      .getReviewNext("new")
      .then((response) => setNewCount(response.remaining + (response.item ? 1 : 0)))
      .catch(() => {});
  }, [mode, item]);

  useEffect(() => {
    return () => {
      if (transitionTimer.current != null) {
        window.clearTimeout(transitionTimer.current);
        transitionTimer.current = null;
      }
    };
  }, []);

  /**
   * 「已看过」只在 New 模式下、用户主动跳过时写入。取下一张本身是纯读取——
   * 否则光是打开这一页（或刷新）就会静默消耗回看队列。
   * 漫游模式下更不能写：那是浏览，不是清队列。
   */
  const skip = useCallback(() => {
    if (state !== "ready" || !item || leaving) return;
    const captureId = item.capture.captureId;
    setLeaving("left");
    transitionTimer.current = window.setTimeout(() => {
      transitionTimer.current = null;
      void (async () => {
        if (mode === "new") {
          try {
            await getApi().markReviewSeen(captureId);
          } catch (error) {
            onToast(`标记已看过失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }
        await loadNext(mode);
      })();
    }, 210);
  }, [item, leaving, loadNext, mode, onToast, state]);

  const archive = useCallback(async () => {
    if (state !== "ready" || !item || leaving || item.capture.archived) return;
    if (item.capture.intent === "favorite" && !window.confirm("这是「常用」内容，确认归档？")) {
      return;
    }
    try {
      await getApi().archiveCapture(item.capture.captureId);
      onToast("已归档。");
      setLeaving("right");
      transitionTimer.current = window.setTimeout(() => {
        transitionTimer.current = null;
        void loadNext(mode);
      }, 210);
    } catch (error) {
      onToast(`归档失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [item, leaving, loadNext, mode, onToast, state]);

  // 键盘：← 下一条，→ 归档（不在输入框聚焦时）
  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.matches("input, textarea, select")) return;
      if (state !== "ready" || !item || leaving) return;
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
  }, [archive, item, leaving, skip, state]);

  const archived = item?.capture.archived ?? false;

  return (
    <section className="page">
      <div className="review-stage">
        <div className="mode-tabs review-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "new"}
            className={`mode-tab ${mode === "new" ? "active" : ""}`}
            onClick={() => setMode("new")}
          >
            New（{newCount}）
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "all"}
            className={`mode-tab ${mode === "all" ? "active" : ""}`}
            onClick={() => setMode("all")}
          >
            All
          </button>
        </div>

        {state === "ready" && item ? (
          <>
            {/* 计数只在 tab 上出现一次：卡片上方再写一遍就是同一个数字说两遍 */}
            <div className="card-stack">
              <KnowledgeCard
                density="full"
                card={item.card}
                meta={`${formatTime(item.capture.createdAt)}`}
                className={leaving ? `leave-${leaving}` : ""}
              >
                <button
                  type="button"
                  className="evidence-strip"
                  title={item.originalUrl}
                  aria-label={`打开原文：${hostOf(item.originalUrl)}`}
                  onClick={() => void openExternal(item.originalUrl)}
                >
                  <span className="evidence-mark" aria-hidden="true">
                    ↗
                  </span>
                  <span className="evidence-text">
                    <strong>{item.card.source?.source_id ?? item.capture.sourceId ?? "unknown"}</strong>
                    <span className="evidence-host">{hostOf(item.originalUrl)} · 打开原文</span>
                  </span>
                </button>
              </KnowledgeCard>
            </div>
            {/* actions 留在 card-stack 之外：card-shadow 锚在 stack 底部，
                包进来会让那两道蓝色衬条压到按钮上 */}
            <div className="card-actions">
              <button type="button" className="action-button secondary" onClick={skip} disabled={leaving != null}>
                <span>下一条</span>
                <span className="keycap">←</span>
              </button>
              {/* 漫游会遇到已归档的卡：按钮留在原位但不可点，位置不跳 */}
              <button
                type="button"
                className="action-button keep"
                onClick={() => void archive()}
                disabled={leaving != null || archived}
              >
                <span>{archived ? "已归档" : "归档"}</span>
                <span className="keycap">→</span>
              </button>
            </div>
          </>
        ) : (
          <div className="empty-card empty-state" style={{ width: "min(600px, 92%)" }}>
            <div>
              <strong>
                {state === "loading"
                  ? "抽取中…"
                  : mode === "new"
                    ? "没有待消化的收藏。"
                    : "收藏库里还没有卡片。"}
              </strong>
              <span>
                {state === "loading"
                  ? "正在从收藏库随机抽取一张。"
                  : mode === "new"
                    ? "都看完了。切到 All 可以在全库里随便逛。"
                    : "从顶栏或浏览器插件收藏新内容，解析完成后卡片会出现在这里。"}
              </span>
              {state === "empty" && (
                <div style={{ marginTop: 18 }}>
                  <button type="button" className="btn" onClick={() => void loadNext(mode)}>
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

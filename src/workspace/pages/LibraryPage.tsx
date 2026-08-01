import { useCallback, useEffect, useMemo, useState } from "react";
import { getApi } from "@/shared/api";
import type {
  CaptureIntent,
  CaptureItem,
  CardStateInfo,
  CardType,
  LibraryCard,
  LibraryResponse,
  UpdateCardStateRequest,
} from "@/shared/api/contracts";
import { formatTime } from "@/shared/format";
import { openExternal } from "@/shared/browser";
import { StatusChip } from "@/shared/components/StatusChip";
import { CARD_TYPE_LABELS, KnowledgeCard } from "@/shared/components/KnowledgeCard";

interface LibraryPageProps {
  onToast: (message: string) => void;
}

/**
 * 收藏库（计划 §Task5.2）：三个 tab。
 * - 知识卡片：卡片流（时间倒序、类型/标签筛选、star/隐藏/笔记落 card_states）
 * - 来源：按收藏来源浏览，点进看该来源的全部卡片与原文
 * - 处理状态：原状态表原封不动（REQ-009 / REQ-010 行为不变——产品明确要求）
 */
type LibraryTab = "cards" | "sources" | "status";

export function LibraryPage({ onToast }: LibraryPageProps) {
  const [tab, setTab] = useState<LibraryTab>("cards");

  const tabs: { id: LibraryTab; label: string }[] = [
    { id: "cards", label: "知识卡片" },
    { id: "sources", label: "来源" },
    { id: "status", label: "处理状态" },
  ];

  return (
    <section className="page">
      <div className="page-head">
        <h1>Library</h1>
        <p>翻开收藏库，看清每条的来路与状态。</p>
      </div>

      <div className="mode-tabs library-tabs" role="tablist">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`mode-tab ${tab === item.id ? "active" : ""}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="page-body">
        {tab === "cards" && <CardFeedView onToast={onToast} />}
        {tab === "sources" && <SourcesView onToast={onToast} />}
        {tab === "status" && <CaptureStatusTable onToast={onToast} />}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 知识卡片流
// ---------------------------------------------------------------------------

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function CardFeedView({ onToast }: { onToast: (message: string) => void }) {
  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [states, setStates] = useState<Map<string, CardStateInfo>>(new Map());
  const [typeFilter, setTypeFilter] = useState<CardType | null>(null);
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [noteEditingId, setNoteEditingId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [lib, stateList] = await Promise.all([getApi().getLibrary(), getApi().listCardStates()]);
        if (cancelled) return;
        setLibrary(lib);
        setStates(new Map(stateList.map((state) => [state.cardId, state])));
      } catch (error) {
        onToast(`卡片加载失败：${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onToast]);

  const patchState = useCallback(
    async (cardId: string, patch: UpdateCardStateRequest) => {
      try {
        const next = await getApi().updateCardState(cardId, patch);
        setStates((prev) => new Map(prev).set(cardId, next));
        return true;
      } catch (error) {
        onToast(`保存卡片状态失败：${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    },
    [onToast],
  );

  const allLabels = useMemo(() => {
    const labels = new Set<string>();
    for (const card of library?.cards ?? []) for (const label of card.domainLabels) labels.add(label);
    return [...labels].sort((a, b) => a.localeCompare(b, "zh"));
  }, [library]);

  const hiddenCount = useMemo(
    () => (library?.cards ?? []).filter((card) => states.get(card.cardId)?.hidden).length,
    [library, states],
  );

  const cards = useMemo(() => {
    const list = (library?.cards ?? []).filter((card) => {
      if (!showHidden && states.get(card.cardId)?.hidden) return false;
      if (typeFilter && card.cardType !== typeFilter) return false;
      if (labelFilter && !card.domainLabels.includes(labelFilter)) return false;
      return true;
    });
    // createdAt 倒序；旧 mock 种子可能缺 createdAt，排到末尾
    return [...list].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  }, [library, states, typeFilter, labelFilter, showHidden]);

  const saveNote = useCallback(
    async (cardId: string) => {
      const trimmed = noteDraft.trim();
      const ok = await patchState(cardId, { userNote: trimmed === "" ? null : trimmed });
      if (ok) setNoteEditingId(null);
    },
    [noteDraft, patchState],
  );

  if (library && library.cards.length === 0) {
    return (
      <div className="empty-state">
        <div>
          <strong>还没有知识卡片。</strong>
          <span>收藏页面并完成策展后，卡片会出现在这里。</span>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="library-filter-bar">
        <button
          type="button"
          className={`filter-chip ${typeFilter === null ? "active" : ""}`}
          onClick={() => setTypeFilter(null)}
        >
          全部类型
        </button>
        {(Object.keys(CARD_TYPE_LABELS) as CardType[]).map((type) => (
          <button
            key={type}
            type="button"
            className={`filter-chip ${typeFilter === type ? "active" : ""}`}
            onClick={() => setTypeFilter(typeFilter === type ? null : type)}
          >
            {CARD_TYPE_LABELS[type]}
          </button>
        ))}
        {allLabels.length > 0 && (
          <select
            className="library-label-select"
            value={labelFilter ?? ""}
            aria-label="按标签筛选"
            onChange={(event) => setLabelFilter(event.target.value || null)}
          >
            <option value="">全部标签</option>
            {allLabels.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </select>
        )}
        <label className="library-hidden-toggle">
          <input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} />
          显示已隐藏{hiddenCount > 0 ? `（${hiddenCount}）` : ""}
        </label>
      </div>

      {library && cards.length === 0 && (
        <div className="empty-state">
          <div>
            <strong>没有匹配的卡片。</strong>
            <span>换个筛选条件试试。</span>
          </div>
        </div>
      )}

      <div className="card-feed">
        {cards.map((card) => {
          const state = states.get(card.cardId);
          const url = card.source?.originalUrl;
          return (
            <KnowledgeCard
              key={card.cardId}
              density="compact"
              card={card}
              meta={
                url
                  ? `${hostOf(url)}${card.createdAt ? ` · ${formatTime(card.createdAt)}` : ""}`
                  : card.createdAt
                    ? formatTime(card.createdAt)
                    : undefined
              }
              badge={state?.starred ? <span className="card-star-badge">★</span> : undefined}
              onOpen={url ? () => void openExternal(url) : undefined}
              className={state?.hidden ? "card-is-hidden" : ""}
            >
              {/* 操作区自己消化点击，不冒泡成整卡打开原文 */}
              <div
                className="card-feed-actions"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  className={`filter-chip ${state?.starred ? "active" : ""}`}
                  onClick={() => void patchState(card.cardId, { starred: !state?.starred })}
                >
                  {state?.starred ? "★ 已星标" : "☆ 星标"}
                </button>
                <button
                  type="button"
                  className="filter-chip"
                  onClick={() => void patchState(card.cardId, { hidden: !state?.hidden })}
                >
                  {state?.hidden ? "取消隐藏" : "隐藏"}
                </button>
                <button
                  type="button"
                  className="filter-chip"
                  onClick={() => {
                    setNoteEditingId(card.cardId);
                    setNoteDraft(state?.userNote ?? "");
                  }}
                >
                  {state?.userNote ? "改笔记" : "记笔记"}
                </button>
              </div>
              {noteEditingId === card.cardId ? (
                <div
                  className="card-note-editor"
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <textarea
                    value={noteDraft}
                    rows={3}
                    placeholder="写点想法（留空保存即清除笔记）"
                    onChange={(event) => setNoteDraft(event.target.value)}
                  />
                  <div className="card-note-editor-actions">
                    <button type="button" className="btn btn-primary" onClick={() => void saveNote(card.cardId)}>
                      保存
                    </button>
                    <button type="button" className="btn" onClick={() => setNoteEditingId(null)}>
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                state?.userNote && <p className="card-user-note">{state.userNote}</p>
              )}
            </KnowledgeCard>
          );
        })}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 来源视图
// ---------------------------------------------------------------------------

function SourcesView({ onToast }: { onToast: (message: string) => void }) {
  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const lib = await getApi().getLibrary();
        if (!cancelled) setLibrary(lib);
      } catch (error) {
        onToast(`来源加载失败：${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onToast]);

  const cardsBySource = useMemo(() => {
    const map = new Map<string, LibraryCard[]>();
    for (const card of library?.cards ?? []) {
      const sourceId = card.source?.source_id;
      if (!sourceId) continue;
      const list = map.get(sourceId) ?? [];
      list.push(card);
      map.set(sourceId, list);
    }
    return map;
  }, [library]);

  const selected = library?.sources.find((source) => source.source_id === selectedId) ?? null;

  if (library && library.sources.length === 0) {
    return (
      <div className="empty-state">
        <div>
          <strong>还没有来源。</strong>
          <span>从顶栏粘贴 URL，或用浏览器插件按钮收藏当前页面。</span>
        </div>
      </div>
    );
  }

  if (selected) {
    const cards = cardsBySource.get(selected.source_id) ?? [];
    return (
      <div className="source-detail">
        <div className="source-detail-head">
          <button type="button" className="btn" onClick={() => setSelectedId(null)}>
            ← 返回来源列表
          </button>
          <h2>{selected.metadata.title ?? hostOf(selected.originalUrl)}</h2>
          <button type="button" className="btn" onClick={() => void openExternal(selected.originalUrl)}>
            打开原文
          </button>
        </div>

        <h3 className="source-section-title">知识卡片（{cards.length}）</h3>
        <div className="card-feed">
          {cards.map((card) => (
            <KnowledgeCard key={card.cardId} density="compact" card={card} />
          ))}
        </div>

        <h3 className="source-section-title">原文段落（{selected.blocks.length}）</h3>
        <div className="source-blocks">
          {selected.blocks.map((block) => (
            <p key={block.blockId} className="source-block">
              {block.text}
            </p>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="source-list">
      {(library?.sources ?? []).map((source) => (
        <button key={source.source_id} type="button" className="source-row" onClick={() => setSelectedId(source.source_id)}>
          <span className="source-row-title">{source.metadata.title ?? hostOf(source.originalUrl)}</span>
          <span className="source-row-meta">
            {hostOf(source.originalUrl)} · {cardsBySource.get(source.source_id)?.length ?? 0} 张卡片
          </span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 处理状态表（原 LibraryPage 主体，行为原封不动——产品明确要求）
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 2000;
const IN_FLIGHT = new Set(["idle", "fetching", "parsing"]);

/**
 * 状态可见性（REQ-009）：in-flight 记录每 2s 轮询直到进入终态。
 * 失败重试（REQ-010）：失败记录保留错误类型，可重试且不生成重复记录。
 */
function CaptureStatusTable({ onToast }: { onToast: (message: string) => void }) {
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

  if (loaded && captures.length === 0) {
    return (
      <div className="empty-state">
        <div>
          <strong>收藏库是空的。</strong>
          <span>从顶栏粘贴 URL，或用浏览器插件按钮收藏当前页面。</span>
        </div>
      </div>
    );
  }

  return (
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
            {capture.parseWarnings && capture.parseWarnings.length > 0 && (
              <div className="capture-warning-list" aria-label="抓取告警">
                {capture.parseWarnings.map((warning, index) => (
                  <div
                    key={`${warning.stage}:${warning.code}:${index}`}
                    className="capture-warning"
                    title={`阶段：${warning.stage}；${warning.recoverable ? "可重试" : "不可重试"}`}
                  >
                    <strong>
                      抓取告警 · {warning.stage} · {warning.code}
                    </strong>
                    <span>{warning.message}</span>
                  </div>
                ))}
              </div>
            )}
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
            {!capture.archived &&
              (capture.status === "failed" ||
                (capture.status === "done" && (capture.parseWarnings?.length ?? 0) > 0)) && (
              <button type="button" className="btn" onClick={() => void retry(capture)}>
                {capture.status === "failed" ? "重试" : "重新抓取"}
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
  );
}

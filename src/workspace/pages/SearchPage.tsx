import { useCallback, useEffect, useMemo, useState } from "react";
import { getApi } from "@/shared/api";
import type { ChatCitation, ChatHistoryEntry, ChatTurn } from "@/shared/api/contracts";
import { formatTime, locatorText } from "@/shared/format";
import { openExternal } from "@/shared/browser";
import { KnowledgeCard } from "@/shared/components/KnowledgeCard";

/** chunk 命中只通过 citations（source_kind: "chunk"）到达 UI；存量历史 turn 缺 source_kind 时视为 card。 */
function chunkCitations(turn: ChatTurn): ChatCitation[] {
  return turn.citations.filter((citation) => citation.source_kind === "chunk");
}

function countChunkCitations(turn: ChatTurn): number {
  return chunkCitations(turn).length;
}

interface SearchPageProps {
  onToast: (message: string) => void;
}

type ViewMode = "answer" | "results";

/**
 * 调用模式（DEV.md §5.3）：自然语言 / 关键词查询本地收藏库。
 * 回答只基于命中的收藏，每个核心结论带可点击 [n] citation；
 * 证据不足时明确展示未找到，不用通用模型知识伪装。
 */
export function SearchPage({ onToast }: SearchPageProps) {
  const [query, setQuery] = useState("收藏之后，怎样让内容重新进入注意力？");
  const [mode, setMode] = useState<ViewMode>("answer");
  const [turn, setTurn] = useState<ChatTurn | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [history, setHistory] = useState<ChatHistoryEntry[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);

  const loadHistory = useCallback(() => {
    getApi()
      .listChatHistory()
      .then(setHistory)
      .catch(() => setHistory([]));
  }, []);

  useEffect(loadHistory, [loadHistory]);

  const runSearch = useCallback(
    async (event?: React.FormEvent) => {
      event?.preventDefault();
      const value = query.trim();
      if (!value || busy) return;
      setBusy(true);
      setConfirmed(null);
      try {
        const result = await getApi().chat(value);
        setTurn(result);
        loadHistory(); // 新问答入历史
      } catch (error) {
        onToast(`检索失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [query, busy, onToast, loadHistory],
  );

  /** 从历史抽屉回放完整 ChatTurn（answer、citations、命中卡片原样恢复）。 */
  const openHistoryEntry = useCallback(
    async (entry: ChatHistoryEntry) => {
      try {
        const past = await getApi().getChatTurn(entry.query_id);
        if (!past) {
          onToast("该条历史已不存在。");
          return;
        }
        setQuery(entry.query);
        setTurn(past);
        setMode("answer");
        setConfirmed(null);
        setHistoryOpen(false);
      } catch (error) {
        onToast(`加载历史失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [onToast],
  );

  const confirmProposal = useCallback(
    async (decision: "confirm" | "dismiss") => {
      const proposal = turn?.project_proposal;
      if (!proposal) return;
      try {
        const result = await getApi().confirmProposal({ proposal_id: proposal.proposal_id, decision });
        if (decision === "confirm") {
          setConfirmed(proposal.proposal_id);
          onToast(`Project「${result.title}」已确认，${result.linked_card_ids.length} 张卡已建立双链。`);
        } else {
          setTurn((current) => (current ? { ...current, project_proposal: null } : current));
          onToast("已忽略该 Project 建议。");
        }
      } catch (error) {
        onToast(`Project 操作失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [turn, onToast],
  );

  return (
    <section className="page">
      <div className="page-head">
        <h1>Recall</h1>
        <p>输入真实问题，召回你的收藏。</p>
      </div>

      <div className="page-body">
        <form className="search-box" onSubmit={runSearch}>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="检索问题"
            autoComplete="off"
            placeholder="用自然语言或关键词检索收藏库"
          />
          <button type="submit" aria-label="开始检索" disabled={busy}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="10.5" cy="10.5" r="6" />
              <path d="m15 15 4.7 4.7" />
            </svg>
          </button>
        </form>
        <div className="query-meta">
          <span>
            {busy
              ? "检索与生成中…"
              : turn
                ? `${turn.retrieved_cards.length} 张命中卡片${countChunkCitations(turn) > 0 ? ` · ${countChunkCitations(turn)} 段原文片段` : ""} · ${turn.generation.latency_ms}ms · ${turn.generation.model}`
                : "等待查询"}
          </span>
          <button type="button" className="history-toggle" onClick={() => setHistoryOpen(true)}>
            问答历史{history.length > 0 ? `（${history.length}）` : ""}
          </button>
        </div>

        {turn && (
          <>
            <div className="mode-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={mode === "answer"}
                className={`mode-tab ${mode === "answer" ? "active" : ""}`}
                onClick={() => setMode("answer")}
              >
                AI 回答
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "results"}
                className={`mode-tab ${mode === "results" ? "active" : ""}`}
                onClick={() => setMode("results")}
              >
                命中材料（{turn.retrieved_cards.length + countChunkCitations(turn)}）
              </button>
            </div>

            {mode === "answer" ? (
              <AnswerView turn={turn} confirmed={confirmed} onConfirm={confirmProposal} />
            ) : (
              <ResultsView turn={turn} />
            )}
          </>
        )}
      </div>

      {historyOpen && (
        <HistoryDrawer
          entries={history}
          onClose={() => setHistoryOpen(false)}
          onSelect={(entry) => void openHistoryEntry(entry)}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 问答历史抽屉：右侧滑出，点击回放完整 ChatTurn
// ---------------------------------------------------------------------------

function HistoryDrawer({
  entries,
  onClose,
  onSelect,
}: {
  entries: ChatHistoryEntry[];
  onClose: () => void;
  onSelect: (entry: ChatHistoryEntry) => void;
}) {
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="history-drawer" aria-label="问答历史">
        <header className="history-drawer-head">
          <span>问答历史</span>
          <button type="button" className="history-close" onClick={onClose} aria-label="关闭历史">
            ×
          </button>
        </header>
        <div className="history-list">
          {entries.length === 0 && (
            <div className="empty-state" style={{ minHeight: 140, border: "none", background: "transparent" }}>
              <div>
                <strong>还没有问答记录。</strong>
                <span>每次检索都会自动保存在本机，点击可回放当时的回答与引用。</span>
              </div>
            </div>
          )}
          {entries.map((entry) => (
            <button key={entry.query_id} type="button" className="history-item" onClick={() => onSelect(entry)}>
              <span className="history-query">{entry.query}</span>
              <span className="history-meta">
                {entry.status === "answered" ? "已回答" : "证据不足"} · {formatTime(entry.createdAt)}
                {entry.citationCount > 0 ? ` · ${entry.citationCount} 引用` : ""}
              </span>
              {entry.answerPreview && <span className="history-preview">{entry.answerPreview}…</span>}
            </button>
          ))}
        </div>
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------
// 回答视图：answer 内联 [n] marker + citation 列表 + project proposal
// ---------------------------------------------------------------------------

function AnswerView({
  turn,
  confirmed,
  onConfirm,
}: {
  turn: ChatTurn;
  confirmed: string | null;
  onConfirm: (decision: "confirm" | "dismiss") => Promise<void>;
}) {
  const citationsByMarker = useMemo(() => {
    const map = new Map<number, ChatCitation>();
    turn.citations.forEach((citation) => map.set(citation.marker, citation));
    return map;
  }, [turn.citations]);

  const jumpToCitation = useCallback(
    (marker: number) => {
      const citation = citationsByMarker.get(marker);
      if (citation?.original_url) void openExternal(citation.original_url);
      const element = document.querySelector(`[data-citation-marker="${marker}"]`);
      element?.scrollIntoView({ behavior: "smooth", block: "center" });
      element?.classList.remove("flash");
      window.setTimeout(() => element?.classList.add("flash"), 20);
    },
    [citationsByMarker],
  );

  if (turn.status === "insufficient_evidence") {
    return (
      <div className="answer-panel">
        <div className="empty-state" style={{ minHeight: 160, border: "none", background: "transparent" }}>
          <div>
            <strong>收藏库里没有找到足够证据。</strong>
            <span>不会用通用模型知识伪装成收藏结果。换个问法，或先收藏相关内容。</span>
          </div>
        </div>
        <GenerationMeta turn={turn} />
      </div>
    );
  }

  const segments = (turn.answer ?? "").split(/(\[\d+\])/g);

  return (
    <>
      <div className="answer-panel">
        <p className="answer-text">
          {segments.map((segment, index) => {
            const match = /^\[(\d+)\]$/.exec(segment);
            if (!match) return <span key={index}>{segment}</span>;
            const marker = Number(match[1]);
            return (
              <button
                key={index}
                type="button"
                className="citation-marker"
                title={citationsByMarker.get(marker)?.quote ?? "查看引用"}
                onClick={() => jumpToCitation(marker)}
              >
                {marker}
              </button>
            );
          })}
        </p>

        <div className="citation-list">
          {turn.citations.map((citation) => (
            <div key={citation.marker} className="citation-item" data-citation-marker={citation.marker}>
              <span className="citation-rank">{citation.marker}</span>
              <div>
                {citation.quote && <div className="citation-quote">「{citation.quote}」</div>}
                <div className="citation-source">
                  {citation.source_kind === "chunk" && <span className="citation-kind">原文片段（未经提炼）</span>}
                  <span>{citation.source_id}</span>
                  <span>
                    {citation.block_id} · {locatorText(citation.locator)}
                  </span>
                  {citation.original_url && (
                    <a
                      href={citation.original_url}
                      target="_blank"
                      rel="noreferrer noopener"
                      onClick={(event) => {
                        event.preventDefault();
                        void openExternal(citation.original_url!);
                      }}
                    >
                      打开原文 ↗
                    </a>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        <GenerationMeta turn={turn} />
      </div>

      {turn.project_proposal && (
        <div className="proposal-card">
          <h3>
            {turn.project_proposal.mode === "go"
              ? `建议并入已有 Project「${turn.project_proposal.matched_project?.title ?? turn.project_proposal.title}」`
              : `建议新建 Project「${turn.project_proposal.title}」`}
          </h3>
          <p className="proposal-rationale">{turn.project_proposal.rationale}</p>
          <div className="proposal-meta">
            {turn.project_proposal.mode === "go" ? "并入" : "新建"} · 候选 {turn.project_proposal.candidate_card_ids.length} 张卡 ·
            意图：{turn.project_proposal.intent}
          </div>
          {confirmed === turn.project_proposal.proposal_id ? (
            <div className="proposal-meta">已确认，等待 backend 完成 Project mutation。</div>
          ) : (
            <div className="proposal-actions">
              <button type="button" className="btn btn-primary" onClick={() => void onConfirm("confirm")}>
                确认建立双链
              </button>
              <button type="button" className="btn" onClick={() => void onConfirm("dismiss")}>
                忽略
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function GenerationMeta({ turn }: { turn: ChatTurn }) {
  return (
    <div className="generation-meta">
      {turn.generation.provider} · {turn.generation.model} · {turn.generation.latency_ms}ms · schema{" "}
      {turn.schema_version}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 命中卡片视图
// ---------------------------------------------------------------------------

function ResultsView({ turn }: { turn: ChatTurn }) {
  const citationByCard = useMemo(() => {
    const map = new Map<string, ChatCitation>();
    turn.citations.forEach((citation) => {
      // chunk 命中的 citation 没有 card_id，下面单独渲染成原文片段行
      if (citation.card_id) map.set(citation.card_id, citation);
    });
    return map;
  }, [turn.citations]);
  const chunkRows = chunkCitations(turn);

  if (turn.retrieved_cards.length === 0 && chunkRows.length === 0) {
    return (
      <div className="empty-state" style={{ maxWidth: 860 }}>
        <div>
          <strong>没有命中卡片。</strong>
          <span>换一个问题，或先收藏更多内容。</span>
        </div>
      </div>
    );
  }

  return (
    <div className="result-list">
      {turn.retrieved_cards.map((card) => {
        const citation = citationByCard.get(card.card_id);
        return (
          <KnowledgeCard
            key={card.card_id}
            density="compact"
            card={{
              cardId: card.card_id,
              cardType: card.card_type,
              title: card.title,
              body: card.body,
              domainLabels: card.domain_labels,
            }}
            meta={citation ? citation.source_id : card.card_id}
            badge={
              <span className={`signal ${card.matched_by.length > 1 ? "both" : ""}`}>
                {card.matched_by.map((channel) => (channel === "llm" ? "模型精选" : channel === "fts" ? "关键词" : channel === "vector" ? "向量" : channel)).join(" + ")}
              </span>
            }
            onOpen={citation?.original_url ? () => void openExternal(citation.original_url!) : undefined}
          />
        );
      })}
      {chunkRows.map((citation, index) => (
        <button
          key={`chunk-${citation.marker}`}
          type="button"
          className="result-row"
          onClick={() => {
            if (citation.original_url) void openExternal(citation.original_url);
          }}
        >
          <span className="result-rank">{index + 1}</span>
          <span>
            <span className="result-title">原文片段（未经提炼）</span>
            <span className="result-snippet">{citation.quote ?? ""}</span>
            <span className="result-source">
              {citation.source_id} · {citation.block_id} · {locatorText(citation.locator)}
            </span>
          </span>
          <span className="signal">向量</span>
        </button>
      ))}
    </div>
  );
}

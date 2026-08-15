import { useEffect, useMemo, useState } from "react";
import { getApi } from "@/shared/api";
import type {
  CardType,
  LibraryCard,
  LibraryResponse,
  LibrarySource,
  SourceBlock,
} from "@/shared/api/contracts";
import { hostOf, locatorText } from "@/shared/format";
import { openExternal } from "@/shared/browser";
import { CARD_TYPE_LABELS } from "@/shared/components/KnowledgeCard";

/**
 * 来源追溯：每张卡片都能回到 source_id、block、locator 和原始 URL
 * （AGENTS.md：Design for traceability）。数据由 backend 的
 * evidence resolver 按 card → source → block 解析。
 *
 * 列表的单位是**来源**，不是 block：一个来源一条 item，展开才看到
 * 它下面的卡片和被引用的原文段落。按 card × block 平铺会把同一个来源
 * 重复几十行，追溯页读起来像原文 dump，而不是「这条卡从哪来」。
 */

interface TraceEvidence {
  blockId: string;
  quote?: string | null;
  /** 在 source.blocks 里解析到的原文；null = 引用悬空，解析不到 */
  block: SourceBlock | null;
}

interface TraceCard {
  cardId: string;
  title: string;
  cardType: CardType;
  evidence: TraceEvidence[];
}

interface TraceItem {
  source: LibrarySource;
  cards: TraceCard[];
  /** 该来源里被至少一张卡引用过的 block 数 */
  quotedBlocks: number;
  /** 指向不存在 block 的引用条数 */
  dangling: number;
}

function buildItems(library: LibraryResponse): TraceItem[] {
  const sources = new Map<string, LibrarySource>();
  for (const source of library.sources) sources.set(source.source_id, source);
  // 卡片自带的 source 兜底：library.sources 里没有的也不该在追溯页消失
  for (const card of library.cards) {
    if (card.source && !sources.has(card.source.source_id)) {
      sources.set(card.source.source_id, card.source);
    }
  }

  const cardsBySource = new Map<string, LibraryCard[]>();
  for (const card of library.cards) {
    const sourceId = card.source?.source_id;
    if (!sourceId) continue;
    const list = cardsBySource.get(sourceId) ?? [];
    list.push(card);
    cardsBySource.set(sourceId, list);
  }

  return [...sources.values()].map((source) => {
    const blocks = new Map(source.blocks.map((block) => [block.blockId, block]));
    const quoted = new Set<string>();
    let dangling = 0;

    const cards = (cardsBySource.get(source.source_id) ?? []).map((card) => ({
      cardId: card.cardId,
      title: card.title,
      cardType: card.cardType,
      evidence: card.evidence.map((item) => {
        const block = blocks.get(item.blockId) ?? null;
        if (block) quoted.add(block.blockId);
        else dangling += 1;
        return { blockId: item.blockId, quote: item.quote, block };
      }),
    }));

    return { source, cards, quotedBlocks: quoted.size, dangling };
  });
}

export function TracePage() {
  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    void getApi()
      .getLibrary()
      .then((lib) => {
        if (!cancelled) setLibrary(lib);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const items = useMemo(() => (library ? buildItems(library) : []), [library]);

  function toggle(sourceId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
  }

  return (
    <section className="page">
      <div className="page-head">
        <h1>Trace</h1>
        <p>一个来源一条，展开看它下面的卡片回到了原文哪一段。</p>
      </div>

      <div className="page-body">
        {items.length === 0 ? (
          <div className="empty-state">
            <div>
              <strong>{loaded ? "还没有可追溯的来源。" : "加载中…"}</strong>
              {loaded && <span>先收藏一个页面，卡片生成后就能在这里回到原文。</span>}
            </div>
          </div>
        ) : (
          <div className="trace-list">
            {items.map((item) => (
              <TraceSourceItem
                key={item.source.source_id}
                item={item}
                open={expanded.has(item.source.source_id)}
                onToggle={() => toggle(item.source.source_id)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function TraceSourceItem({
  item,
  open,
  onToggle,
}: {
  item: TraceItem;
  open: boolean;
  onToggle: () => void;
}) {
  const { source, cards, quotedBlocks, dangling } = item;
  const title = source.metadata.title ?? hostOf(source.originalUrl);

  return (
    <div className="trace-item">
      <button
        type="button"
        className="trace-item-head"
        aria-expanded={open}
        onClick={onToggle}
        title={source.source_id}
      >
        <span className="trace-item-text">
          <strong className="trace-item-title">{title}</strong>
          <span className="trace-item-meta">
            {hostOf(source.originalUrl)} · {cards.length} 张卡片 · 引用 {quotedBlocks}/
            {source.blocks.length} 段
            {dangling > 0 && <span className="trace-warn">{dangling} 条引用悬空</span>}
          </span>
        </span>
        <span className="trace-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <div className="trace-item-body">
          <a
            className="trace-url"
            href={source.originalUrl}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(event) => {
              event.preventDefault();
              void openExternal(source.originalUrl);
            }}
          >
            打开原文 · {source.originalUrl}
          </a>

          {cards.length === 0 && <p className="trace-quote">这个来源还没有生成卡片。</p>}

          {cards.map((card) => (
            <div key={card.cardId} className="trace-card">
              <div className="trace-card-head">
                <span className="trace-kind">{CARD_TYPE_LABELS[card.cardType] ?? card.cardType}</span>
                <strong>{card.title}</strong>
              </div>
              {card.evidence.length === 0 && <p className="trace-quote">没有引用任何原文段落。</p>}
              {card.evidence.map((evidence) => (
                <div key={`${card.cardId}:${evidence.blockId}`} className="trace-evidence">
                  <span className="trace-evidence-meta">
                    {evidence.blockId}
                    {evidence.block ? ` · ${locatorText(evidence.block.locator)}` : ""}
                  </span>
                  {evidence.block ? (
                    <span className="trace-quote">{evidence.quote ?? evidence.block.text}</span>
                  ) : (
                    <span className="trace-warn">原文里找不到这个 block</span>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

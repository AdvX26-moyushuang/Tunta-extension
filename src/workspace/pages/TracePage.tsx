import { useEffect, useMemo, useState } from "react";
import { getApi } from "@/shared/api";
import type { LibraryResponse } from "@/shared/api/contracts";
import { hostOf, locatorText } from "@/shared/format";
import { openExternal } from "@/shared/browser";

/**
 * 来源追溯：每张卡片都能回到 source_id、block、locator 和原始 URL
 * （AGENTS.md：Design for traceability）。数据由 backend 的
 * evidence resolver 按 card → source → block 解析。
 */
export function TracePage() {
  const [library, setLibrary] = useState<LibraryResponse | null>(null);

  useEffect(() => {
    getApi()
      .getLibrary()
      .then(setLibrary)
      .catch(() => setLibrary(null));
  }, []);

  const rows = useMemo(() => {
    if (!library) return [];
    return library.cards.flatMap((card) =>
      (card.source?.blocks ?? []).map((block) => ({
        cardId: card.cardId,
        cardTitle: card.title,
        block,
        source: card.source!,
        quoted: card.evidence.some((item) => item.blockId === block.blockId),
      })),
    );
  }, [library]);

  return (
    <section className="page">
      <div className="page-head">
        <h1>Trace</h1>
        <p>点开一张卡，回到它的原始出处。</p>
      </div>

      <div className="page-body">
        <div className="trace-table">
          <div className="trace-row header">
            <span>Card / 类型</span>
            <span>Source</span>
            <span>Evidence block</span>
            <span>Locator</span>
          </div>
          {rows.length === 0 && (
            <div className="trace-row">
              <span>—</span>
              <span>{library ? "没有可追溯的卡片" : "加载中…"}</span>
              <span />
              <span />
            </div>
          )}
          {rows.map((row) => (
            <div key={`${row.cardId}:${row.block.blockId}`} className="trace-row">
              <span className="trace-kind" title={row.cardTitle}>
                {row.block.kind}
              </span>
              <span title={row.source.originalUrl}>
                <strong>{row.source.metadata.title ?? row.source.source_id}</strong>
                <br />
                <a
                  className="trace-url"
                  href={row.source.originalUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  onClick={(event) => {
                    event.preventDefault();
                    void openExternal(row.source.originalUrl);
                  }}
                >
                  {hostOf(row.source.originalUrl)}
                </a>
              </span>
              <span>
                <strong>{row.block.blockId}</strong>
                {row.quoted && <span title="被卡片 evidence 直接引用"> ●</span>}
                <br />
                <span className="trace-quote">{row.block.text}</span>
              </span>
              <span>{locatorText(row.block.locator)}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

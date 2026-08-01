import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import cytoscape from "cytoscape";
import { getApi } from "@/shared/api";
import type {
  EntityMentionInfo,
  KaleidoscopeEdge,
  KaleidoscopeEntityGraph,
  KaleidoscopeGraph,
  KaleidoscopeNode,
  LibraryCard,
  LibraryResponse,
} from "@/shared/api/contracts";
import { openExternal } from "@/shared/browser";
import { KnowledgeCard } from "@/shared/components/KnowledgeCard";

interface KaleidoscopePageProps {
  onToast: (message: string) => void;
}

/** 概念视图是默认：实体是索引、卡片是内容、来源是出处。 */
type GraphMode = "entity" | "source";

/**
 * 万花筒：知识图谱。
 *
 * 默认「概念」视图——节点是实体，边是实体共现（纯计算，零 LLM）。这是三层下钻的
 * 入口：点概念 → 侧栏列出提到它的卡片（按来源分组）→ 点卡片回到原文位置。
 * 概念图节点按跨来源数截断到 nodeLimit，超出部分不渲染但在统计里明示总数。
 *
 * 「来源」视图保留原来的收藏关系图，边由共享实体派生，可点「为何相关」
 * 懒加载 LLM 解释（计划 §Task3.5），结果缓存后不再重复调用。
 */
export function KaleidoscopePage({ onToast }: KaleidoscopePageProps) {
  const [mode, setMode] = useState<GraphMode>("entity");
  const [graph, setGraph] = useState<KaleidoscopeGraph | null>(null);
  const [entityGraph, setEntityGraph] = useState<KaleidoscopeEntityGraph | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [mentions, setMentions] = useState<EntityMentionInfo[]>([]);
  const [rebuilding, setRebuilding] = useState(false);
  const [explanations, setExplanations] = useState<Record<string, string>>({});
  const [explainingEdgeId, setExplainingEdgeId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      // 实体侧栏（计划 §Task5.3）需要 mention 与卡片内容，随图一并拉取
      const [data, entityData, lib, mentionList] = await Promise.all([
        getApi().getKaleidoscope(),
        getApi().getEntityGraph(),
        getApi().getLibrary(),
        getApi().listEntityMentions(),
      ]);
      setGraph(data);
      setEntityGraph(entityData);
      setLibrary(lib);
      setMentions(mentionList);
    } catch (error) {
      onToast(`万花筒加载失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [onToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rebuild = useCallback(async () => {
    setRebuilding(true);
    try {
      const result = await getApi().rebuildKaleidoscope();
      onToast(`关系网络已重建：${result.sources} 个来源 · ${result.edges} 条关联。`);
      await refresh();
    } catch (error) {
      onToast(`重建关系失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRebuilding(false);
    }
  }, [onToast, refresh]);

  const explainEdge = useCallback(
    async (edgeId: string) => {
      setExplainingEdgeId(edgeId);
      try {
        const result = await getApi().explainKaleidoscopeEdge(edgeId);
        setExplanations((prev) => ({ ...prev, [edgeId]: result.explanation }));
      } catch (error) {
        onToast(`解释生成失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setExplainingEdgeId(null);
      }
    },
    [onToast],
  );

  useEffect(() => {
    const container = containerRef.current;
    const active = mode === "entity" ? entityGraph : graph;
    if (!container || !active || active.nodes.length === 0) return;
    // 概念图：节点权重取跨来源数——一个概念被多条不同收藏提到，比在同一篇里反复出现更有信息量
    const elements =
      mode === "entity" && entityGraph
        ? [
            ...entityGraph.nodes.map((node) => ({
              data: { id: node.entityId, label: node.name, weight: node.sourceCount },
            })),
            ...entityGraph.edges.map((edge) => ({
              data: {
                id: edge.edgeId,
                source: edge.aId,
                target: edge.bId,
                // 概念图只有「共现」一种关系，边上不写字：线的粗细已经表达强度，
                // 文字只会和节点标签抢位置。等真有多种关系类型了再加回来。
                label: "",
                strength: edge.strength,
              },
            })),
          ]
        : [
            ...(graph?.nodes ?? []).map((node) => ({
              data: { id: node.sourceId, label: node.title, weight: node.cardCount },
            })),
            ...(graph?.edges ?? []).map((edge) => ({
              data: {
                id: edge.edgeId,
                source: edge.fromSourceId,
                target: edge.toSourceId,
                label: edge.relation,
                strength: edge.strength,
              },
            })),
          ];
    const cy = cytoscape({
      container,
      elements,
      style: [
        {
          selector: "node",
          style: {
            "background-color": "#2b7ab3",
            "border-color": "#f5f1e7",
            "border-width": 2,
            label: "data(label)",
            color: "#151614",
            "font-size": 11,
            "font-weight": 600,
            "text-wrap": "wrap",
            "text-max-width": "130px",
            "text-valign": "bottom",
            "text-margin-y": 8,
            "text-background-color": "#f5f1e7",
            "text-background-opacity": 0.8,
            "text-background-padding": "3px",
            width: "mapData(weight, 0, 8, 30, 58)",
            height: "mapData(weight, 0, 8, 30, 58)",
          },
        },
        {
          selector: "node:selected",
          style: {
            "background-color": "#ffe57c",
            "border-color": "#151614",
            "border-width": 2.5,
          },
        },
        {
          selector: "edge",
          style: {
            width: "mapData(strength, 0, 1, 1.2, 5)",
            "line-color": "#a88a70",
            "curve-style": "bezier",
            label: "data(label)",
            "font-size": 9,
            color: "#696b64",
            "text-rotation": "autorotate",
            "text-background-color": "#f5f1e7",
            "text-background-opacity": 0.9,
            "text-background-padding": "2px",
          },
        },
      ],
      /*
       * 概念图节点多、标签长，原参数（repulsion 12000 / edge 150）会把节点挤成
       * 一团：9 节点实测最近中心距只有 41px，而节点直径最大 58px——直接压在一起。
       *
       * 下面这组实测最近中心距 74px，同时长宽比最接近画布，fit 后几乎不缩小。
       * 单纯把 repulsion 调更大会把图拉成细高条，反而在横向画布里显得更小，
       * 所以 gravity 要跟着往回收。
       */
      layout: {
        name: "cose",
        animate: true,
        nodeRepulsion: 26_000,
        idealEdgeLength: 150,
        componentSpacing: 120,
        nodeOverlap: 20,
        gravity: 1.2,
        numIter: 1500,
        padding: 56,
      },
      wheelSensitivity: 0.2,
      boxSelectionEnabled: false,
    });
    cy.on("tap", "node", (event) => {
      const id = String(event.target.id());
      // 概念图点节点直接进实体侧栏；来源图点节点进来源详情
      if (mode === "entity") {
        setSelectedEntityId(id);
        setSelectedId(null);
        return;
      }
      setSelectedId(id);
      setSelectedEntityId(null);
    });
    cy.on("tap", (event) => {
      if (event.target !== cy) return;
      setSelectedId(null);
      setSelectedEntityId(null);
    });
    return () => cy.destroy();
  }, [graph, entityGraph, mode]);

  const selected: KaleidoscopeNode | null = graph?.nodes.find((node) => node.sourceId === selectedId) ?? null;

  const cardById = useMemo(
    () => new Map((library?.cards ?? []).map((card) => [card.cardId, card])),
    [library],
  );

  /** 选中来源提及的实体（去重），附全库 mention 数；hub 降权排后。 */
  const sourceEntities = useMemo(() => {
    if (!selected) return [];
    const globalCount = new Map<string, number>();
    for (const mention of mentions) {
      globalCount.set(mention.entityId, (globalCount.get(mention.entityId) ?? 0) + 1);
    }
    const seen = new Map<string, EntityMentionInfo>();
    for (const mention of mentions) {
      if (mention.sourceId !== selected.sourceId) continue;
      if (!seen.has(mention.entityId)) seen.set(mention.entityId, mention);
    }
    return [...seen.values()]
      .map((entity) => ({ entity, count: globalCount.get(entity.entityId) ?? 0 }))
      .sort((a, b) => Number(a.entity.isHub) - Number(b.entity.isHub) || b.count - a.count);
  }, [selected, mentions]);

  /** 选中实体的全部 mention：按来源分组，组内按卡片时间倒序，组间按最新卡倒序。 */
  const entityGroups = useMemo(() => {
    if (!selectedEntityId) return [];
    const bySource = new Map<string, LibraryCard[]>();
    for (const mention of mentions) {
      if (mention.entityId !== selectedEntityId) continue;
      const card = cardById.get(mention.cardId);
      if (!card) continue;
      const list = bySource.get(mention.sourceId) ?? [];
      list.push(card);
      bySource.set(mention.sourceId, list);
    }
    return [...bySource.entries()]
      .map(([sourceId, cards]) => {
        const sorted = [...cards].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
        return { sourceId, cards: sorted, latest: sorted[0]?.createdAt ?? "" };
      })
      .sort((a, b) => b.latest.localeCompare(a.latest));
  }, [selectedEntityId, mentions, cardById]);

  const selectedEntity = selectedEntityId
    ? mentions.find((mention) => mention.entityId === selectedEntityId) ?? null
    : null;

  const sourceTitle = useCallback(
    (sourceId: string) =>
      graph?.nodes.find((node) => node.sourceId === sourceId)?.title ??
      library?.sources.find((source) => source.source_id === sourceId)?.metadata.title ??
      sourceId,
    [graph, library],
  );

  const selectedRelations: { edge: KaleidoscopeEdge; other: KaleidoscopeNode | undefined }[] =
    selected && graph
      ? graph.edges
          .filter((edge) => edge.fromSourceId === selected.sourceId || edge.toSourceId === selected.sourceId)
          .map((edge) => ({
            edge,
            other: graph.nodes.find((node) =>
              edge.fromSourceId === selected.sourceId ? node.sourceId === edge.toSourceId : node.sourceId === edge.fromSourceId,
            ),
          }))
      : [];

  /** 概念图被截断时明示总数，避免用户以为看到的是全部（计划 §4）。 */
  const statsLabel = useMemo(() => {
    if (mode === "source") {
      return graph ? `${graph.nodes.length} 个来源 · ${graph.edges.length} 条关联` : "加载中…";
    }
    if (!entityGraph) return "加载中…";
    const shown =
      entityGraph.totalEntities > entityGraph.nodes.length
        ? `显示 ${entityGraph.nodes.length} / 共 ${entityGraph.totalEntities} 个概念`
        : `${entityGraph.nodes.length} 个概念`;
    return `${shown} · ${entityGraph.edges.length} 条共现`;
  }, [mode, graph, entityGraph]);

  return (
    <section className="page">
      <div className="page-head">
        <h1>Kaleidoscope</h1>
        <p>让收藏彼此照亮，发现内容之间的关联。</p>
      </div>

      <div className="page-body">
        {graph && graph.nodes.length === 0 ? (
          <div className="empty-state">
            <div>
              <strong>万花筒还没有内容。</strong>
              <span>先从顶栏收藏一些内容；每加入一条新收藏，关联都会自动计算并入图。</span>
            </div>
          </div>
        ) : (
          <>
            <div className="kaleidoscope-toolbar">
              <div className="mode-tabs" role="tablist" aria-label="图谱视图">
                {([
                  { id: "entity" as const, label: "概念" },
                  { id: "source" as const, label: "来源" },
                ]).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={mode === item.id}
                    className={`mode-tab ${mode === item.id ? "active" : ""}`}
                    onClick={() => {
                      setMode(item.id);
                      setSelectedId(null);
                      setSelectedEntityId(null);
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <span className="kaleidoscope-stats">{statsLabel}</span>
              <div className="kaleidoscope-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={rebuilding}
                  title="实体共现纯计算重建：零 LLM 调用，秒级完成"
                  onClick={() => void rebuild()}
                >
                  {rebuilding ? "重建中…" : "重建关系"}
                </button>
                <button type="button" className="btn" disabled={rebuilding} onClick={() => void refresh()}>
                  刷新图谱
                </button>
              </div>
            </div>
            <div className="kaleidoscope-layout">
              <div className="kaleidoscope-canvas" ref={containerRef} aria-label="收藏知识图谱" />
              <aside className="kaleidoscope-panel">
                {selectedEntity ? (
                  <>
                    {mode === "source" && (
                      <button type="button" className="btn" onClick={() => setSelectedEntityId(null)}>
                        ← 返回来源
                      </button>
                    )}
                    <span className="kaleidoscope-panel-kind">{selectedEntity.entityType}</span>
                    <h2 className="kaleidoscope-panel-title">{selectedEntity.entityName}</h2>
                    <div className="kaleidoscope-mentions">
                      {entityGroups.map((group) => (
                        <div key={group.sourceId} className="kaleidoscope-mention-group">
                          <span className="kaleidoscope-relations-head">{sourceTitle(group.sourceId)}</span>
                          {group.cards.map((card) => {
                            const url =
                              card.source?.originalUrl ??
                              graph?.nodes.find((node) => node.sourceId === group.sourceId)?.url;
                            return (
                              <KnowledgeCard
                                key={card.cardId}
                                density="inline"
                                card={card}
                                onOpen={url ? () => void openExternal(url) : undefined}
                              />
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </>
                ) : selected ? (
                  <>
                    <span className="kaleidoscope-panel-kind">{selected.platform}</span>
                    <h2 className="kaleidoscope-panel-title">{selected.title}</h2>
                    {selected.summary && <p className="kaleidoscope-panel-summary">{selected.summary}</p>}
                    <p className="kaleidoscope-panel-meta">
                      {selected.cardCount} 张卡片 ·{" "}
                      <a href={selected.url} target="_blank" rel="noreferrer">
                        打开原文
                      </a>
                    </p>
                    {sourceEntities.length > 0 && (
                      <div className="kaleidoscope-entities">
                        <span className="kaleidoscope-relations-head">实体（{sourceEntities.length}）</span>
                        <div className="kaleidoscope-entity-chips">
                          {sourceEntities.map(({ entity, count }) => (
                            <button
                              key={entity.entityId}
                              type="button"
                              className={`filter-chip ${entity.isHub ? "is-hub" : ""}`}
                              title={entity.isHub ? "高频泛化实体（仅作标签）" : undefined}
                              onClick={() => setSelectedEntityId(entity.entityId)}
                            >
                              {entity.entityName}（{count}）
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="kaleidoscope-relations">
                      <span className="kaleidoscope-relations-head">关联（{selectedRelations.length}）</span>
                      {selectedRelations.length === 0 ? (
                        <p className="kaleidoscope-relation-empty">暂无关联：继续收藏相关内容后会自动连边。</p>
                      ) : (
                        selectedRelations.map(({ edge, other }) => (
                          <div key={edge.edgeId} className="kaleidoscope-relation-item">
                            <button
                              type="button"
                              className="kaleidoscope-relation"
                              onClick={() => setSelectedId(other?.sourceId ?? null)}
                            >
                              <span className="kaleidoscope-relation-title">{other?.title ?? "未知来源"}</span>
                              <span className="kaleidoscope-relation-why">
                                {edge.relation} · {Math.round(edge.strength * 100)}%
                              </span>
                            </button>
                            {explanations[edge.edgeId] ? (
                              <p className="kaleidoscope-relation-explain">{explanations[edge.edgeId]}</p>
                            ) : (
                              <button
                                type="button"
                                className="kaleidoscope-relation-explain-btn"
                                disabled={explainingEdgeId !== null}
                                onClick={() => void explainEdge(edge.edgeId)}
                              >
                                {explainingEdgeId === edge.edgeId ? "解释生成中…" : "为何相关？"}
                              </button>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </>
                ) : (
                  <div className="kaleidoscope-panel-hint">
                    {mode === "entity" ? (
                      <>
                        <strong>点击概念查看它出现在哪些卡片里。</strong>
                        <span>
                          节点大小 = 这个概念被多少条不同收藏提到；连线 = 两个概念出现在同一张卡片。
                          高频泛化概念不进图，只在来源视图里作为标签保留。
                        </span>
                      </>
                    ) : (
                      <>
                        <strong>点击节点查看来源详情。</strong>
                        <span>拖拽画布平移，滚轮缩放；孤立的节点说明还没有发现它与其它收藏的实质关联。</span>
                      </>
                    )}
                  </div>
                )}
              </aside>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

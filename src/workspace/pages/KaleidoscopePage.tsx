import { useCallback, useEffect, useRef, useState } from "react";
import cytoscape from "cytoscape";
import { getApi } from "@/shared/api";
import type { KaleidoscopeEdge, KaleidoscopeGraph, KaleidoscopeNode } from "@/shared/api/contracts";

interface KaleidoscopePageProps {
  onToast: (message: string) => void;
}

/**
 * 万花筒：收藏来源的知识图谱。
 * 每次新收藏完成策展后，后台流水线用实体共现纯计算重建关联边
 * （见 src/local/kaleidoscope.ts，零 LLM）；这里只负责读取与渲染。
 * 节点大小反映该来源的卡片数量，边解释懒加载（计划 §Task3.5）：
 * 点「为何相关」才调 LLM，结果缓存后不再重复调用。
 */
export function KaleidoscopePage({ onToast }: KaleidoscopePageProps) {
  const [graph, setGraph] = useState<KaleidoscopeGraph | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [explanations, setExplanations] = useState<Record<string, string>>({});
  const [explainingEdgeId, setExplainingEdgeId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await getApi().getKaleidoscope();
      setGraph(data);
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
    if (!container || !graph || graph.nodes.length === 0) return;
    const cy = cytoscape({
      container,
      elements: [
        ...graph.nodes.map((node) => ({
          data: { id: node.sourceId, label: node.title, weight: node.cardCount },
        })),
        ...graph.edges.map((edge) => ({
          data: {
            id: edge.edgeId,
            source: edge.fromSourceId,
            target: edge.toSourceId,
            label: edge.relation,
            strength: edge.strength,
          },
        })),
      ],
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
      layout: {
        name: "cose",
        animate: true,
        nodeRepulsion: 12_000,
        idealEdgeLength: 150,
        padding: 48,
      },
      wheelSensitivity: 0.2,
      boxSelectionEnabled: false,
    });
    cy.on("tap", "node", (event) => {
      setSelectedId(String(event.target.id()));
    });
    cy.on("tap", (event) => {
      if (event.target === cy) setSelectedId(null);
    });
    return () => cy.destroy();
  }, [graph]);

  const selected: KaleidoscopeNode | null = graph?.nodes.find((node) => node.sourceId === selectedId) ?? null;
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
              <span className="kaleidoscope-stats">
                {graph ? `${graph.nodes.length} 个来源 · ${graph.edges.length} 条关联` : "加载中…"}
              </span>
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
                {selected ? (
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
                    <strong>点击节点查看来源详情。</strong>
                    <span>拖拽画布平移，滚轮缩放；孤立的节点说明还没有发现它与其它收藏的实质关联。</span>
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

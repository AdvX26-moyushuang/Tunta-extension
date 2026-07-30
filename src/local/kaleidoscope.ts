import { computeEntityGraph, deriveSourceEdges, getStore } from "./store";

export interface RebuildGraphResult {
  sources: number;
  edges: number;
}

/**
 * 知识图谱重建（计划 §Task3.3）：纯计算，零 LLM。
 * 实体共现 → entity_edges + hub 降级；来源关系边从共享实体派生，
 * 替代原来的 linkSourceIntoGraph / rebuildAllGraphLinks（每 source 一次 LLM 调用）。
 * 派生数据全量重写，收藏入库与手动重建走同一条路。
 */
export async function rebuildKnowledgeGraph(): Promise<RebuildGraphResult> {
  const store = getStore();
  const [documents, cards, entities, mentions] = await Promise.all([
    store.listDocuments(),
    store.listCards(),
    store.listEntities(),
    store.listMentions(),
  ]);
  const graph = computeEntityGraph(mentions, cards.length);
  await store.setHubEntities(graph.hubIds);
  await store.replaceEntityEdges(graph.edges);

  const sourceEdges = deriveSourceEdges(entities, mentions, graph.hubIds, new Date().toISOString());
  await store.clearKaleidoscopeEdges();
  await store.putKaleidoscopeEdges(sourceEdges);
  return { sources: documents.length, edges: sourceEdges.length };
}

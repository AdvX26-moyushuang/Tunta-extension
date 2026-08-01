import { callChatCompletion } from "./provider";
import type { LocalSettings } from "./settings";
import { computeEntityGraph, deriveSourceEdges, getStore } from "./store";
import type { StoredDocument, StoredKaleidoscopeEdge } from "./store";

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

const EDGE_EXPLAIN_SYSTEM_PROMPT = `你是 Tunta 收藏库的图谱解说员。给定两条收藏的标题与摘要，以及它们共同涉及的实体，解释这两条收藏为何相关。
- 2~3 句话，直接说关联点，不要客套、不要复述标题
- 只基于给定材料，不要编造材料外的信息
- 直接输出解释正文，不要任何前缀或格式标记`;

function describeSource(label: string, doc: StoredDocument | undefined): string {
  if (!doc) return `${label}：（来源已删除）`;
  const title = doc.curatedTitle ?? doc.title;
  return `${label}：${title}
摘要：${doc.summary ?? "（无）"}`;
}

/**
 * 边解释懒加载（计划 §Task3.5）：只在用户点开一条边时调用。
 * 写入时 O(n) 次 LLM 调用变成读取时按需 O(1)；缓存由调用方（api）负责。
 */
export async function explainEdgeRelation(
  settings: LocalSettings,
  edge: StoredKaleidoscopeEdge,
  from: StoredDocument | undefined,
  to: StoredDocument | undefined,
): Promise<string> {
  const user = [
    describeSource("收藏 A", from),
    describeSource("收藏 B", to),
    `已知关联：${edge.relation}`,
  ].join("\n\n");
  return callChatCompletion(settings.chat, EDGE_EXPLAIN_SYSTEM_PROMPT, user, 1024);
}

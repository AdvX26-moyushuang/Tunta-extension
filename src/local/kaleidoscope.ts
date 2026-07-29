import {
  getStore,
  kaleidoscopeEdgeId,
  type StoredDocument,
  type StoredKaleidoscopeEdge,
} from "./store";
import { callChatCompletion, ProviderError } from "./provider";
import type { LocalSettings } from "./settings";

const DIGEST_LIMIT = 40;
const DIGEST_SUMMARY_CHARS = 80;
const MAX_LINKS = 5;

const LINK_SYSTEM_PROMPT = `你是 Tunta 收藏库的知识图谱策展人。给定一条新收藏和已有收藏清单，判断新收藏与哪些已有收藏存在实质关联。

要求：
- 只关联主题、领域或方法上真正有联系的内容，不要因为措辞相似而硬连
- 没有实质关系就不输出，宁缺毋滥；最多 ${MAX_LINKS} 条
- relation 用一句短语说明两者为何相关（不超过 24 字）
- strength 取 0~1 的小数，表示关联强度
- 只输出一个 JSON 数组，元素形如 {"target": 清单编号, "relation": "关系短语", "strength": 0.8}；一条都没有就输出 []
- 不要输出任何其他文字`;

function displayTitle(doc: StoredDocument): string {
  return doc.curatedTitle ?? doc.title;
}

function buildUserPrompt(fresh: StoredDocument, candidates: StoredDocument[]): string {
  const digest = candidates
    .map((doc, index) => {
      const summary = doc.summary ? doc.summary.slice(0, DIGEST_SUMMARY_CHARS) : "（无摘要）";
      return `[${index + 1}] ${displayTitle(doc)}\n${summary}`;
    })
    .join("\n\n");
  const lines = [`新收藏：${displayTitle(fresh)}`];
  if (fresh.summary) lines.push(`摘要：${fresh.summary}`);
  lines.push("", "已有收藏清单：", digest);
  return lines.join("\n");
}

interface RawLink {
  target?: unknown;
  relation?: unknown;
  strength?: unknown;
}

function parseLinks(raw: string, upperBound: number): { target: number; relation: string; strength: number }[] {
  const match = /\[[\s\S]*?\]/.exec(raw);
  if (!match) {
    throw new ProviderError("万花筒关联输出中没有 JSON 数组。", "GRAPH_PARSE_FAILED");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    throw new ProviderError("万花筒关联输出的 JSON 数组无法解析。", "GRAPH_PARSE_FAILED");
  }
  if (!Array.isArray(parsed)) return [];
  const links: { target: number; relation: string; strength: number }[] = [];
  const seen = new Set<number>();
  for (const item of parsed as RawLink[]) {
    const target = item?.target;
    const relation = typeof item?.relation === "string" ? item.relation.trim() : "";
    const strength = typeof item?.strength === "number" ? item.strength : NaN;
    if (typeof target !== "number" || !Number.isInteger(target) || target < 1 || target > upperBound) continue;
    if (seen.has(target) || !relation) continue;
    seen.add(target);
    links.push({
      target,
      relation: relation.slice(0, 40),
      strength: Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 0.5,
    });
    if (links.length >= MAX_LINKS) break;
  }
  return links;
}

async function computeLinks(
  settings: LocalSettings,
  fresh: StoredDocument,
  candidates: StoredDocument[],
): Promise<StoredKaleidoscopeEdge[]> {
  const raw = await callChatCompletion(settings.chat, LINK_SYSTEM_PROMPT, buildUserPrompt(fresh, candidates), 2048);
  const links = parseLinks(raw, candidates.length);
  const now = new Date().toISOString();
  return links.map((link) => {
    const other = candidates[link.target - 1]!;
    return {
      edgeId: kaleidoscopeEdgeId(fresh.sourceId, other.sourceId),
      fromSourceId: fresh.sourceId,
      toSourceId: other.sourceId,
      relation: link.relation,
      strength: link.strength,
      createdAt: now,
    };
  });
}

export async function linkSourceIntoGraph(settings: LocalSettings, sourceId: string): Promise<number> {
  const documents = await getStore().listDocuments();
  const fresh = documents.find((doc) => doc.sourceId === sourceId);
  if (!fresh) {
    throw new ProviderError("本地文档缺失，无法计算万花筒关联。", "GRAPH_SOURCE_MISSING");
  }
  const candidates = documents
    .filter((doc) => doc.sourceId !== sourceId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, DIGEST_LIMIT);

  await getStore().deleteKaleidoscopeEdgesForSource(sourceId);
  if (candidates.length === 0) return 0;

  const edges = await computeLinks(settings, fresh, candidates);
  await getStore().putKaleidoscopeEdges(edges);
  return edges.length;
}

export interface RebuildGraphResult {
  sources: number;
  edges: number;
}


export async function rebuildAllGraphLinks(settings: LocalSettings): Promise<RebuildGraphResult> {
  const documents = (await getStore().listDocuments()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  await getStore().clearKaleidoscopeEdges();
  let written = 0;
  for (let index = 1; index < documents.length; index += 1) {
    const fresh = documents[index]!;
    const candidates = documents.slice(0, index).slice(-DIGEST_LIMIT);
    const edges = await computeLinks(settings, fresh, candidates);
    await getStore().putKaleidoscopeEdges(edges);
    written += edges.length;
  }
  return { sources: documents.length, edges: written };
}

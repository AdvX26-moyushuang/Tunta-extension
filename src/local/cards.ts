import type { CardType } from "@/shared/api/contracts";
import { ENTITY_TYPES, type CardEntity, type EntityType, type StoredCard, type StoredDocument } from "./store/types.js";
import type { ParserBlock } from "./parser";
import { callChatCompletion, ProviderError } from "./provider.js";
import type { LocalSettings } from "./settings";
import { deduplicateCards, type CardWithoutId } from "./card-normalize.js";

const CARD_TYPES: CardType[] = ["insight", "quote", "method", "question", "action"];

// 实体字段让输出显著变长（计划 §Task3.1）：block 预算 12000→10000、max_tokens 6144→8192，
// 否则长文档策展会开始随机触发 PROVIDER_TRUNCATED。
const PROMPT_BLOCK_BUDGET = 10_000;

const CURATION_MAX_TOKENS = 8192;

const MAX_ENTITIES_PER_CARD = 5;

const MAX_CARDS_PER_DOC = 8;

interface RawGeneratedCard {
  card_type?: unknown;
  title?: unknown;
  body?: unknown;
  evidence_block_ids?: unknown;
  domain_labels?: unknown;
  entities?: unknown;
}

/**
 * 实体抽取结果清洗（计划 §Task3.1）：type 限死六个值，越界丢弃；
 * lower(name)+type 去重（与 Task3.2 的实体表唯一约束同口径）；每卡最多 5 个。
 */
export function toValidEntities(raw: unknown): CardEntity[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const entities: CardEntity[] = [];
  for (const item of raw) {
    const candidate = item as { name?: unknown; type?: unknown };
    const name = typeof candidate?.name === "string" ? candidate.name.trim() : "";
    if (!name || name.length > 40) continue;
    if (!ENTITY_TYPES.includes(candidate?.type as EntityType)) continue;
    const type = candidate.type as EntityType;
    const key = `${name.toLowerCase()}\u0000${type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entities.push({ name, type });
    if (entities.length >= MAX_ENTITIES_PER_CARD) break;
  }
  return entities;
}


function extractJsonObject(text: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new ProviderError("策展结果不是 JSON 对象。", "CARDS_BAD_JSON");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch (cause) {
    throw new ProviderError(`策展结果 JSON 解析失败：${cause instanceof Error ? cause.message : String(cause)}`, "CARDS_BAD_JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProviderError("策展结果不是 JSON 对象。", "CARDS_BAD_JSON");
  }
  return parsed as Record<string, unknown>;
}

function buildPrompt(doc: StoredDocument): string {
  const blocks = doc.parserOutput.blocks;
  const lines: string[] = [];
  let used = 0;
  for (const block of blocks) {
    const line = `${block.block_id} | ${block.text}`;
    if (used + line.length > PROMPT_BLOCK_BUDGET) break;
    lines.push(line);
    used += line.length;
  }
  return [
    `收藏标题：${doc.title}`,
    `来源：${doc.url}`,
    "",
    "原文 blocks（block_id | 文本）：",
    ...lines,
  ].join("\n");
}

const CURATION_SYSTEM_PROMPT = `你是 Tunta 收藏库的策展人。用户收藏了一段内容（文章正文或视频字幕，已切成带 block_id 的块），由你决定它是否值得进入收藏卡片，以及生成几张卡片。

先做价值判断：
- 导航页、链接列表、纯推广、登录墙提示、几乎没有信息量的内容 → worth_keeping=false
- 有实质知识内容（观点、方法、教程、叙事）→ worth_keeping=true

再做卡片提炼（仅当 worth_keeping=true）：
- 数量由内容决定，0~${MAX_CARDS_PER_DOC} 张；内容单薄就少做，不要凑数
- 每张卡片只保留一个可独立成立的知识点（洞察 / 引文 / 方法 / 问题 / 行动）
- 证据必须引用真实存在的 block_id，至少 1 条；可以合并多个相邻 block 作为共同证据；不得编造 block_id
- 忽略页眉页脚、导航、相关推荐、按钮文案等噪声块，它们不应出现在证据里
- domain_labels 给 1-3 个领域标签（如 个人知识管理、前端工程）
- entities 抽取卡片里的关键实体，0~5 个；type 只能是 person（人物）、concept（概念）、tool（工具/产品）、method（方法论）、work（作品/文章/书）、org（组织/公司）之一；name 用原文里的规范叫法，不要自己改写

同时给出来源元数据（worth_keeping=false 时也要给）：
- source.title：干净准确的来源标题，去除站点后缀（如「_哔哩哔哩_bilibili」）、营销词与导航噪声，不超过 40 字
- source.summary：一句话说明这段内容讲了什么，不超过 60 字

只输出 JSON 对象，不要输出任何其他文字：
{"source":{"title":"来源标题","summary":"一句话摘要"},"assessment":{"worth_keeping":true或false,"reason":"一句话理由"},"cards":[{"card_type":"insight|quote|method|question|action","title":"卡片标题","body":"卡片正文（忠于原文，可适度压缩）","evidence_block_ids":["block:paragraph:001"],"domain_labels":["标签"],"entities":[{"name":"约束","type":"concept"}]}]}
worth_keeping=false 时 cards 输出空数组。`;

function toValidCard(raw: unknown, blocks: ParserBlock[], doc: StoredDocument): CardWithoutId | null {
  const candidate = raw as RawGeneratedCard;
  if (typeof candidate?.title !== "string" || !candidate.title.trim()) return null;
  if (typeof candidate?.body !== "string" || !candidate.body.trim()) return null;
  const cardType = CARD_TYPES.includes(candidate.card_type as CardType) ? (candidate.card_type as CardType) : "insight";
  const validIds = new Set(blocks.map((block) => block.block_id));
  const requested = Array.isArray(candidate.evidence_block_ids) ? candidate.evidence_block_ids : [];
  const evidenceIds = requested.filter((id): id is string => typeof id === "string" && validIds.has(id));
  if (evidenceIds.length === 0) return null; // 不可追溯，扔掉扔掉一定要扔掉 // 何意味
  const blockById = new Map(blocks.map((block) => [block.block_id, block]));
  const labels = Array.isArray(candidate.domain_labels)
    ? candidate.domain_labels.filter((label): label is string => typeof label === "string" && label.trim().length > 0).slice(0, 3)
    : [];
  return {
    sourceId: doc.sourceId,
    cardType,
    title: candidate.title.trim(),
    body: candidate.body.trim(),
    domainLabels: labels,
    evidence: evidenceIds.slice(0, 3).map((id) => ({ blockId: id, quote: blockById.get(id)?.text.slice(0, 160) ?? null })),
    entities: toValidEntities(candidate.entities),
    embedding: null,
    createdAt: new Date().toISOString(),
  };
}

export interface CurationResult {
  
  source: { title: string | null; summary: string | null };
  assessment: { worthKeeping: boolean; reason: string };
  cards: StoredCard[];
}


function toSourceMeta(raw: unknown): { title: string | null; summary: string | null } {
  const candidate = (raw ?? {}) as { title?: unknown; summary?: unknown };
  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  const summary = typeof candidate.summary === "string" ? candidate.summary.trim() : "";
  return {
    title: title.length > 0 && title.length <= 80 ? title : null,
    summary: summary.length > 0 ? summary.slice(0, 120) : null,
  };
}







export async function generateCardsForDocument(settings: LocalSettings, doc: StoredDocument): Promise<CurationResult> {
  const blocks = doc.parserOutput.blocks;
  if (blocks.length === 0) {
    throw new ProviderError("文档没有可用 blocks，无法生成卡片。", "CARDS_NO_BLOCKS");
  }
  
  const answer = await callChatCompletion(settings.chat, CURATION_SYSTEM_PROMPT, buildPrompt(doc), CURATION_MAX_TOKENS);
  const raw = extractJsonObject(answer);
  const source = toSourceMeta(raw.source);
  const assessmentRaw = (raw.assessment ?? {}) as { worth_keeping?: unknown; reason?: unknown };
  const worthKeeping = assessmentRaw.worth_keeping !== false; // 缺省视为有价值
  const reason = typeof assessmentRaw.reason === "string" ? assessmentRaw.reason.trim() : "";
  if (!worthKeeping) {
    return { source, assessment: { worthKeeping: false, reason: reason || "策展人判定内容不值得卡片化。" }, cards: [] };
  }
  const rawCards = Array.isArray(raw.cards) ? raw.cards : [];
  const validCards = rawCards
    .slice(0, MAX_CARDS_PER_DOC)
    .map((item) => toValidCard(item, blocks, doc))
    .filter((card): card is CardWithoutId => card !== null);
  const normalized = await deduplicateCards(validCards, doc.sourceId);
  const cards = normalized.cards;
  if (normalized.duplicateCount > 0) {
    console.warn(
      `[tunta] 策展结果包含重复卡片（${doc.sourceId}）：已移除 ${normalized.duplicateCount} 张`,
    );
  }
  if (cards.length === 0) {
    
    throw new ProviderError("策展结果为有价值内容，但生成的卡片全部无效（标题/正文/证据缺失）。", "CARDS_ALL_INVALID");
  }
  return { source, assessment: { worthKeeping: true, reason }, cards };
}

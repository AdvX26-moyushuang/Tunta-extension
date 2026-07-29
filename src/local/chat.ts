import type { ChatCitation, ChatLocator, ChatTurn } from "@/shared/api/contracts";
import type { StoredCard, StoredChunk, StoredDocument } from "./store/types";
import type { ParserBlock } from "./parser";
import { callChatCompletion, ProviderError } from "./provider";
import type { RetrieveHit } from "./retrieve";
import type { LocalSettings } from "./settings";
import { tokenize } from "./text";

const INSUFFICIENT_TOKEN = "INSUFFICIENT";

const CHAT_SYSTEM_PROMPT = `你是 Tunta 收藏库的问答助手。只能基于给定的收藏材料回答用户问题。

要求：
- 材料分两类：提炼卡片，以及标注为「原文片段（未经提炼）」的原文摘录；后者未经提炼，证据等级低于卡片，引用时注意甄别
- 每个核心结论后面紧跟引用标记 [n]，n 是材料编号；一个结论可以引用多个标记
- 不得使用材料之外的信息，不得编造引用编号
- 如果材料不足以回答，只输出 ${INSUFFICIENT_TOKEN}，不要输出其他内容
- 用中文简洁回答`;

function emptyLocator(): ChatLocator {
  return { kind: "unknown", start_ms: null, end_ms: null, page_number: null, paragraph_index: null, selector: null };
}

function blockLocator(block: ParserBlock | undefined): ChatLocator {
  if (!block) return emptyLocator();
  return {
    kind: block.locator.kind,
    start_ms: block.locator.start_ms ?? null,
    end_ms: block.locator.end_ms ?? null,
    page_number: block.locator.page_number ?? null,
    paragraph_index: block.locator.paragraph_index ?? null,
    selector: block.locator.selector ?? null,
  };
}

function buildUserPrompt(query: string, hits: RetrieveHit[]): string {
  const lines = hits.flatMap((hit, index) =>
    hit.kind === "card"
      ? [`[${index + 1}] ${hit.card.title}`, hit.card.body, ""]
      : [`[${index + 1}] 原文片段（未经提炼）`, hit.chunk.text, ""],
  );
  return [`问题：${query}`, "", "收藏材料：", ...lines, "回答："].join("\n");
}

/** chunk 内实际匹配的 block：按查询 token 重叠挑，不能一律取第一个。 */
function pickChunkBlock(chunk: StoredChunk, doc: StoredDocument | undefined, query: string): ParserBlock | undefined {
  const blocks = (doc?.parserOutput.blocks ?? []).filter((block) => chunk.blockIds.includes(block.block_id));
  if (blocks.length === 0) return undefined;
  const queryTokens = new Set(tokenize(query));
  let best = blocks[0];
  let bestOverlap = -1;
  for (const block of blocks) {
    const overlap = tokenize(block.text).filter((token) => queryTokens.has(token)).length;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = block;
    }
  }
  return best;
}

function buildCitations(
  answer: string,
  query: string,
  hits: RetrieveHit[],
  documents: Map<string, StoredDocument>,
): ChatCitation[] {
  const markers = [...answer.matchAll(/\[(\d+)\]/g)]
    .map((match) => Number.parseInt(match[1], 10))
    .filter((marker) => marker >= 1 && marker <= hits.length);
  const unique = [...new Set(markers)];
  const citations: ChatCitation[] = [];
  for (const marker of unique) {
    const hit = hits[marker - 1];
    if (hit.kind === "chunk") {
      const doc = documents.get(hit.chunk.sourceId);
      const block = pickChunkBlock(hit.chunk, doc, query);
      citations.push({
        marker,
        source_kind: "chunk",
        card_id: null,
        source_id: hit.chunk.sourceId,
        block_id: block?.block_id ?? hit.chunk.blockIds[0] ?? "",
        quote: block?.text.slice(0, 160) ?? hit.chunk.text.slice(0, 160),
        original_url: doc?.url ?? null,
        locator: blockLocator(block),
      });
      continue;
    }
    const doc = documents.get(hit.card.sourceId);
    const evidence = hit.card.evidence[0];
    const block = doc?.parserOutput.blocks.find((item) => item.block_id === evidence?.blockId);
    citations.push({
      marker,
      source_kind: "card",
      card_id: hit.card.cardId,
      source_id: hit.card.sourceId,
      block_id: evidence?.blockId ?? "",
      quote: evidence?.quote ?? block?.text.slice(0, 160) ?? null,
      original_url: doc?.url ?? null,
      locator: blockLocator(block),
    });
  }
  return citations;
}

export interface ChatTurnInput {
  query: string;
  hits: RetrieveHit[];
  documents: Map<string, StoredDocument>;
  settings: LocalSettings;
}

export async function runChatTurn(input: ChatTurnInput): Promise<ChatTurn> {
  const { query, hits, documents, settings } = input;
  const queryId = `query:local:${Date.now().toString(36)}`;
  // retrieved_cards 是卡片契约，chunk 命中只通过 citations（source_kind: "chunk"）暴露
  const retrievedCards = hits.flatMap((hit) =>
    hit.kind === "card"
      ? [{
          card_id: hit.card.cardId,
          card_type: hit.card.cardType,
          title: hit.card.title,
          body: hit.card.body,
          domain_labels: hit.card.domainLabels,
          score: hit.score,
          matched_by: hit.matchedBy,
        }]
      : [],
  );

  
  if (hits.length === 0) {
    return {
      schema_version: "0.3.0",
      query_id: queryId,
      status: "insufficient_evidence",
      answer: null,
      citations: [],
      retrieved_cards: [],
      project_proposal: null,
      generation: { provider: settings.chat.provider, model: settings.chat.model, latency_ms: 0 },
    };
  }

  const started = Date.now();
  
  const rawAnswer = await callChatCompletion(settings.chat, CHAT_SYSTEM_PROMPT, buildUserPrompt(query, hits), 4096);
  const latency = Date.now() - started;

  if (rawAnswer.includes(INSUFFICIENT_TOKEN)) {
    return {
      schema_version: "0.3.0",
      query_id: queryId,
      status: "insufficient_evidence",
      answer: null,
      citations: [],
      retrieved_cards: retrievedCards,
      project_proposal: null,
      generation: { provider: settings.chat.provider, model: settings.chat.model, latency_ms: latency },
    };
  }

  return {
    schema_version: "0.3.0",
    query_id: queryId,
    status: "answered",
    answer: rawAnswer,
    citations: buildCitations(rawAnswer, query, hits, documents),
    retrieved_cards: retrievedCards,
    project_proposal: null,
    generation: { provider: settings.chat.provider, model: settings.chat.model, latency_ms: latency },
  };
}


// open query
const OPEN_QUERY_DIGEST_LIMIT = 24;
const OPEN_QUERY_DIGEST_BODY_CHARS = 120;
const OPEN_QUERY_MAX_PICKS = 6;

const OPEN_QUERY_SYSTEM_PROMPT = `你是 Tunta 收藏库的导览员。用户提出了一个开放性问题（例如「有什么推荐的」「有什么新鲜的」），问题本身没有明确主题，由你从卡片清单中挑出最值得展示的卡片。
- 最多 ${OPEN_QUERY_MAX_PICKS} 张，可以更少，不要硬凑
- 「新鲜 / 最近」类问题优先挑收藏日期新的；「推荐」类问题挑信息量高、代表性强的
- 只输出一个 JSON 数组，元素是清单编号，例如 [3, 1, 7]；一张都不合适就输出 []
- 不要输出任何其他文字`;


export async function selectCardsForOpenQuery(
  settings: LocalSettings,
  cards: StoredCard[],
  query: string,
): Promise<RetrieveHit[]> {
  const candidates = [...cards]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, OPEN_QUERY_DIGEST_LIMIT);
  const digest = candidates
    .map(
      (card, index) =>
        `[${index + 1}] ${card.title}（收藏于 ${card.createdAt.slice(0, 10)}）\n${card.body.slice(0, OPEN_QUERY_DIGEST_BODY_CHARS)}`,
    )
    .join("\n\n");
    

  const raw = await callChatCompletion(
    settings.chat,
    OPEN_QUERY_SYSTEM_PROMPT,
    `用户问题：${query}\n\n卡片清单：\n${digest}`,
    2048,
  );
  return parsePickArray(raw, candidates.length).map((pick) => ({
    kind: "card" as const,
    card: candidates[pick - 1]!,
    score: 0,
    matchedBy: ["llm"],
  }));
}


function parsePickArray(raw: string, upperBound: number): number[] {
  const match = /\[[\s\S]*?\]/.exec(raw);
  if (!match) {
    throw new ProviderError("模型精选输出中没有 JSON 数组。", "SELECTION_PARSE_FAILED");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    throw new ProviderError("模型精选输出的 JSON 数组无法解析。", "SELECTION_PARSE_FAILED");
  }
  if (!Array.isArray(parsed)) return [];
  const picks: number[] = [];
  for (const value of parsed) {
    if (typeof value !== "number" || !Number.isInteger(value)) continue;
    if (value < 1 || value > upperBound || picks.includes(value)) continue;
    picks.push(value);
    if (picks.length >= OPEN_QUERY_MAX_PICKS) break;
  }
  return picks;
}

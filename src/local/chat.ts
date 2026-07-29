import type { ChatCitation, ChatLocator, ChatTurn } from "@/shared/api/contracts";
import type { StoredCard, StoredDocument } from "./store/types";
import { callChatCompletion, ProviderError } from "./provider";
import type { ScoredCard } from "./retrieve";
import type { LocalSettings } from "./settings";

const INSUFFICIENT_TOKEN = "INSUFFICIENT";

const CHAT_SYSTEM_PROMPT = `你是 Tunta 收藏库的问答助手。只能基于给定的收藏卡片回答用户问题。

要求：
- 每个核心结论后面紧跟引用标记 [n]，n 是卡片编号；一个结论可以引用多个标记
- 不得使用卡片之外的信息，不得编造引用编号
- 如果卡片不足以回答，只输出 ${INSUFFICIENT_TOKEN}，不要输出其他内容
- 用中文简洁回答`;

function emptyLocator(): ChatLocator {
  return { kind: "unknown", start_ms: null, end_ms: null, page_number: null, paragraph_index: null, selector: null };
}

function buildUserPrompt(query: string, hits: ScoredCard[]): string {
  const lines = hits.flatMap((hit, index) => [
    `[${index + 1}] ${hit.card.title}`,
    hit.card.body,
    "",
  ]);
  return [`问题：${query}`, "", "收藏卡片：", ...lines, "回答："].join("\n");
}


function buildCitations(answer: string, hits: ScoredCard[], documents: Map<string, StoredDocument>): ChatCitation[] {
  const markers = [...answer.matchAll(/\[(\d+)\]/g)]
    .map((match) => Number.parseInt(match[1], 10))
    .filter((marker) => marker >= 1 && marker <= hits.length);
  const unique = [...new Set(markers)];
  const citations: ChatCitation[] = [];
  for (const marker of unique) {
    const hit = hits[marker - 1];
    const doc = documents.get(hit.card.sourceId);
    const evidence = hit.card.evidence[0];
    const block = doc?.parserOutput.blocks.find((item) => item.block_id === evidence?.blockId);
    citations.push({
      marker,
      card_id: hit.card.cardId,
      source_id: hit.card.sourceId,
      block_id: evidence?.blockId ?? "",
      quote: evidence?.quote ?? block?.text.slice(0, 160) ?? null,
      original_url: doc?.url ?? null,
      locator: block
        ? {
            kind: block.locator.kind,
            start_ms: block.locator.start_ms ?? null,
            end_ms: block.locator.end_ms ?? null,
            page_number: block.locator.page_number ?? null,
            paragraph_index: block.locator.paragraph_index ?? null,
            selector: block.locator.selector ?? null,
          }
        : emptyLocator(),
    });
  }
  return citations;
}

export interface ChatTurnInput {
  query: string;
  hits: ScoredCard[];
  documents: Map<string, StoredDocument>;
  settings: LocalSettings;
}

export async function runChatTurn(input: ChatTurnInput): Promise<ChatTurn> {
  const { query, hits, documents, settings } = input;
  const queryId = `query:local:${Date.now().toString(36)}`;
  const retrievedCards = hits.map((hit) => ({
    card_id: hit.card.cardId,
    card_type: hit.card.cardType,
    title: hit.card.title,
    body: hit.card.body,
    domain_labels: hit.card.domainLabels,
    score: hit.score,
    matched_by: hit.matchedBy,
  }));

  
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
    citations: buildCitations(rawAnswer, hits, documents),
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
): Promise<ScoredCard[]> {
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

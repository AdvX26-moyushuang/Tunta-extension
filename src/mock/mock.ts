/**
 * Mock API：backend 未就绪前让前端独立运行。
 *
 * 数据来源：
 * - 卡片 / 图 / chat turn 来自 contracts/ 的官方 fixtures（复制到 ./fixtures），
 *   保证 mock 数据永远满足 versioned contract。
 * - 原文 source / blocks 与收藏记录是 App 级数据，按 prototype 消费形态构造。
 *
 * 所有写操作只发生在内存里，刷新页面即重置；状态推进用定时器模拟，
 * 便于观察 idle / fetching / parsing / done / failed 五态。
 */
import type { TuntaApi } from "@/shared/api/client";
import type {
  BackendStatus,
  CaptureIntent,
  CaptureItem,
  CardStateInfo,
  ChatHistoryEntry,
  ChatTurn,
  ConfirmProposalResponse,
  EntityMentionInfo,
  KaleidoscopeEdgeExplanation,
  KaleidoscopeEntityGraph,
  KaleidoscopeGraph,
  KaleidoscopeRebuildResult,
  LibraryCard,
  LibraryResponse,
  LibrarySource,
  ProjectProposalMode,
  RetrieveResponse,
  ReviewQueueResponse,
  SourceBlock,
  SubmitCaptureRequest,
  SubmitCaptureResult,
} from "@/shared/api/contracts";
import { chooseReviewCandidate, createSingleFlight } from "@/local/review";

import articleOutput from "./fixtures/intelligence-output-article.json";
import chatAnsweredGo from "./fixtures/chat-answered-proposal-go.json";
import chatInsufficient from "./fixtures/chat-insufficient-evidence.json";
import chatOpenQuery from "./fixtures/chat-open-query-llm-selection.json";

const MOCK_LATENCY_MS = 240;

function delay<T>(value: T, ms = MOCK_LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Library：合同 fixture 的卡片 + 构造的原文 source
// ---------------------------------------------------------------------------

const ARTICLE_URL = "https://example.com/articles/attention-loop";

const ARTICLE_SOURCE: LibrarySource = {
  source_id: articleOutput.source_id,
  originalUrl: ARTICLE_URL,
  metadata: { title: "收藏的价值发生在再次出现时" },
  blocks: [
    {
      blockId: "block:paragraph:001",
      kind: "paragraph",
      text: "收藏的价值不在于保存，而在于让内容重新进入人的注意力循环。",
      locator: { kind: "paragraph", paragraphIndex: 1 },
    },
    {
      blockId: "block:paragraph:002",
      kind: "paragraph",
      text: "可追溯的卡片可以把原内容带回当前项目，而不是生成另一条不可验证的信息流。",
      locator: { kind: "paragraph", paragraphIndex: 2 },
    },
  ] satisfies SourceBlock[],
};

const BILIBILI_URL = "https://www.bilibili.com/video/BV1xx411c7mD";

const BILIBILI_SOURCE: LibrarySource = {
  source_id: "bilibili:BV1xx411c7mD",
  originalUrl: BILIBILI_URL,
  metadata: { title: "示例视频：如何建立回看习惯" },
  blocks: [
    {
      blockId: "block:subtitle:001",
      kind: "subtitle",
      text: "第一步不是整理，而是让收藏在碎片时间里重新出现。",
      locator: { kind: "timestamp", startMs: 12_400, endMs: 18_900 },
    },
    {
      blockId: "block:subtitle:002",
      kind: "subtitle",
      text: "归档之前先确认它不再对你有用，而不是因为你忘了它。",
      locator: { kind: "timestamp", startMs: 47_200, endMs: 53_000 },
    },
  ] satisfies SourceBlock[],
};

const EXTRA_CARD: LibraryCard = {
  cardId: "card:mock:video-review-habit",
  cardType: "method",
  title: "回看要在归档之前发生",
  body: "碎片时间里随机重现已收藏内容，确认无用再归档，避免收藏夹变成只进不出的仓库。",
  domainLabels: ["收藏管理"],
  evidence: [{ blockId: "block:subtitle:002", quote: BILIBILI_SOURCE.blocks[1].text }],
  source: BILIBILI_SOURCE,
};

function buildLibrary(): LibraryResponse {
  const cards: LibraryCard[] = articleOutput.cards.map((card) => ({
    cardId: card.card_id,
    cardType: card.card_type as LibraryCard["cardType"],
    title: card.title,
    body: card.body,
    domainLabels: ["个人知识管理"],
    evidence: card.evidence.map((item) => ({ blockId: item.block_id, quote: item.quote })),
    source: ARTICLE_SOURCE,
  }));
  cards.push(EXTRA_CARD);
  return {
    sources: [ARTICLE_SOURCE, BILIBILI_SOURCE],
    cards,
    nodes: articleOutput.graph.nodes as LibraryResponse["nodes"],
    edges: articleOutput.graph.edges as LibraryResponse["edges"],
  };
}

// ---------------------------------------------------------------------------
// Kaleidoscope：万花筒知识图谱种子（来源节点 + LLM 关联边）
// ---------------------------------------------------------------------------

function buildKaleidoscope(): KaleidoscopeGraph {
  return {
    nodes: [
      {
        sourceId: ARTICLE_SOURCE.source_id,
        title: "收藏的价值发生在再次出现时",
        summary: "收藏的价值在于让内容重新进入注意力循环",
        platform: "web",
        url: ARTICLE_URL,
        cardCount: articleOutput.cards.length,
      },
      {
        sourceId: BILIBILI_SOURCE.source_id,
        title: "示例视频：如何建立回看习惯",
        summary: "用碎片时间随机重现收藏，确认无用再归档",
        platform: "bilibili",
        url: BILIBILI_URL,
        cardCount: 1,
      },
      {
        sourceId: "web:example.com:stretch-routine",
        title: "常用：每日拉伸流程",
        summary: null,
        platform: "web",
        url: "https://example.com/tutorials/stretch-routine",
        cardCount: 0,
      },
    ],
    edges: [
      {
        edgeId: "kedge:mock:review-loop",
        fromSourceId: ARTICLE_SOURCE.source_id,
        toSourceId: BILIBILI_SOURCE.source_id,
        relation: "同属收藏管理与回看方法论",
        strength: 0.82,
        createdAt: minutesAgo(60 * 8),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Captures：覆盖五态的种子数据
// ---------------------------------------------------------------------------

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function seedCaptures(): CaptureItem[] {
  return [
    {
      captureId: "cap_mock_article",
      url: ARTICLE_URL,
      title: "收藏的价值发生在再次出现时",
      intent: "pending",
      status: "done",
      sourceId: ARTICLE_SOURCE.source_id,
      createdAt: minutesAgo(60 * 26),
      updatedAt: minutesAgo(60 * 26 - 2),
      archived: false,
      failure: null,
    },
    {
      captureId: "cap_mock_video",
      url: BILIBILI_URL,
      title: "示例视频：如何建立回看习惯",
      intent: "pending",
      status: "done",
      sourceId: BILIBILI_SOURCE.source_id,
      createdAt: minutesAgo(60 * 9),
      updatedAt: minutesAgo(60 * 9 - 3),
      archived: false,
      failure: null,
    },
    {
      captureId: "cap_mock_favorite",
      url: "https://example.com/tutorials/stretch-routine",
      title: "常用：每日拉伸流程",
      intent: "favorite",
      status: "done",
      sourceId: "web:example.com:stretch-routine",
      createdAt: minutesAgo(60 * 72),
      updatedAt: minutesAgo(60 * 72 - 1),
      archived: false,
      failure: null,
    },
    {
      captureId: "cap_mock_parsing",
      url: "https://example.com/posts/inbox-zero-notes",
      title: "Inbox Zero 笔记",
      intent: "pending",
      status: "parsing",
      sourceId: null,
      createdAt: minutesAgo(4),
      updatedAt: minutesAgo(4),
      archived: false,
      failure: null,
    },
    {
      captureId: "cap_mock_failed",
      url: "https://example.com/posts/deleted-page",
      title: "已删除的页面",
      intent: "pending",
      status: "failed",
      sourceId: null,
      createdAt: minutesAgo(60 * 30),
      updatedAt: minutesAgo(60 * 30 - 1),
      archived: false,
      failure: {
        code: "FETCH_HTTP_404",
        message: "页面返回 404，来源可能已被删除。",
        stage: "fetch",
        recoverable: true,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Mock 实现
// ---------------------------------------------------------------------------

export function createMockApi(): TuntaApi {
  // let：clearLibrary 可将其重置为空库
  let library = buildLibrary();
  let kaleidoscope = buildKaleidoscope();
  const captures = seedCaptures();
  const cardStates = new Map<string, CardStateInfo>();
  const reviewSeen = new Set<string>();
  const dismissedProposals = new Set<string>();
  const chatHistory: { entry: ChatHistoryEntry; turn: ChatTurn }[] = [];
  let captureCounter = 0;

  /**
   * mock 没有策展流水线，用卡片自带的 domainLabels 当实体，
   * 再叠一个跨全部卡片的概念，凑出有共现边的最小图。
   */
  function mockMentions(): EntityMentionInfo[] {
    return library.cards.flatMap((card) => {
      const names = [...card.domainLabels, "注意力循环"];
      return names.map((name) => ({
        entityId: `entity:concept:${name}`,
        entityName: name,
        entityType: "concept",
        isHub: false,
        cardId: card.cardId,
        sourceId: card.source?.source_id ?? "",
        blockId: card.evidence[0]?.blockId ?? null,
      }));
    });
  }

  function pushChatHistory(query: string, turn: ChatTurn): void {
    chatHistory.unshift({
      entry: {
        query_id: turn.query_id,
        query,
        status: turn.status,
        createdAt: nowIso(),
        answerPreview: turn.answer ? turn.answer.slice(0, 80) : null,
        citationCount: turn.citations.length,
      },
      turn,
    });
    if (chatHistory.length > 100) chatHistory.length = 100;
  }

  function findCapture(captureId: string): CaptureItem {
    const capture = captures.find((item) => item.captureId === captureId);
    if (!capture) throw new Error(`capture not found: ${captureId}`);
    return capture;
  }

  /** 模拟后台解析流水线：fetching -> parsing -> done（约 85%）/ failed。 */
  function schedulePipeline(capture: CaptureItem): void {
    capture.status = "fetching";
    capture.updatedAt = nowIso();
    setTimeout(() => {
      capture.status = "parsing";
      capture.updatedAt = nowIso();
    }, 800);
    setTimeout(() => {
      const host = safeHost(capture.url);
      if (host.includes("deleted") || Math.random() < 0.15) {
        capture.status = "failed";
        capture.failure = {
          code: "FETCH_HTTP_404",
          message: "页面返回 404，来源可能已被删除。",
          stage: "fetch",
          recoverable: true,
        };
      } else {
        capture.status = "done";
        capture.failure = null;
        capture.title = capture.title || `${host} 的收藏`;
        capture.sourceId = `web:${host}:mock-${capture.captureId.slice(-6)}`;
      }
      capture.updatedAt = nowIso();
    }, 2300);
  }

  function cardForCapture(capture: CaptureItem): LibraryCard | null {
    if (capture.sourceId) {
      const card = library.cards.find((item) => item.source?.source_id === capture.sourceId);
      if (card) return card;
    }
    return library.cards[0] ?? null;
  }

  const getReviewNext = createSingleFlight(() => {
    const selection = chooseReviewCandidate(
      captures.map((capture) => {
        const card = cardForCapture(capture);
        return { capture, cards: card ? [card] : [] };
      }),
      reviewSeen,
    );
    if (!selection.candidate) {
      return delay<ReviewQueueResponse>({ item: null, remaining: 0 });
    }

    reviewSeen.add(selection.candidate.capture.captureId);
    const capture = selection.candidate.capture;
    const card = selection.candidate.cards[0];
    return delay<ReviewQueueResponse>({
      item: {
        capture: { ...capture },
        card: structuredClone(card),
        originalUrl: card.source?.originalUrl ?? capture.url,
      },
      remaining: selection.remaining,
    });
  });

  const api: TuntaApi = {
    getStatus: () =>
      delay<BackendStatus>({
        schema_version: "0.2.0",
        intelligence: { embedding: "mock", embedding_dimensions: 384, retrieval: "vector + fts" },
        backend: { mode: "mock", version: "0.1.0" },
      }),

    getLibrary: () => delay(structuredClone(library)),

    listCardStates: () => delay([...cardStates.values()].map((state) => ({ ...state }))),

    updateCardState: (cardId, patch) => {
      const existing = cardStates.get(cardId);
      const next: CardStateInfo = {
        cardId,
        starred: patch.starred ?? existing?.starred ?? false,
        hidden: patch.hidden ?? existing?.hidden ?? false,
        userNote: patch.userNote === undefined ? (existing?.userNote ?? null) : patch.userNote,
        reviewCount: existing?.reviewCount ?? 0,
        lastReviewedAt: existing?.lastReviewedAt ?? null,
        updatedAt: nowIso(),
      };
      cardStates.set(cardId, next);
      return delay({ ...next });
    },

    // mock 无策展流水线：用卡片的 domainLabels 当实体，外加一个跨全部卡片的概念，
    // 合成出的 mention 集合足以驱动概念图与侧栏的完整链路
    listEntityMentions: () => delay(mockMentions()),

    getKaleidoscope: () => delay(structuredClone(kaleidoscope)),

    getEntityGraph: () => {
      const mentions = mockMentions();
      const cards = new Map<string, Set<string>>();
      const sources = new Map<string, Set<string>>();
      const names = new Map<string, { name: string; type: string }>();
      for (const mention of mentions) {
        names.set(mention.entityId, { name: mention.entityName, type: mention.entityType });
        (cards.get(mention.entityId) ?? cards.set(mention.entityId, new Set()).get(mention.entityId)!).add(mention.cardId);
        (sources.get(mention.entityId) ?? sources.set(mention.entityId, new Set()).get(mention.entityId)!).add(mention.sourceId);
      }
      const nodes = [...names.entries()]
        .map(([entityId, meta]) => ({
          entityId,
          name: meta.name,
          type: meta.type,
          mentionCount: cards.get(entityId)?.size ?? 0,
          sourceCount: sources.get(entityId)?.size ?? 0,
        }))
        .sort((a, b) => b.sourceCount - a.sourceCount || b.mentionCount - a.mentionCount);

      const byCard = new Map<string, string[]>();
      for (const mention of mentions) {
        byCard.set(mention.cardId, [...(byCard.get(mention.cardId) ?? []), mention.entityId]);
      }
      const cooccur = new Map<string, number>();
      for (const list of byCard.values()) {
        const sorted = [...new Set(list)].sort();
        for (let i = 0; i < sorted.length; i += 1) {
          for (let j = i + 1; j < sorted.length; j += 1) {
            const key = `${sorted[i]} ${sorted[j]}`;
            cooccur.set(key, (cooccur.get(key) ?? 0) + 1);
          }
        }
      }
      const max = [...cooccur.values()].reduce((acc, value) => Math.max(acc, value), 0);
      return delay<KaleidoscopeEntityGraph>({
        nodes,
        edges: [...cooccur.entries()].map(([key, count]) => {
          const [aId, bId] = key.split(" ") as [string, string];
          return {
            edgeId: `eedge:${aId}::${bId}`,
            aId,
            bId,
            cooccurCount: count,
            pmi: null,
            strength: max > 0 ? count / max : 0,
          };
        }),
        totalEntities: nodes.length,
        nodeLimit: 200,
      });
    },

    rebuildKaleidoscope: () => {
      // mock 无 LLM：重置回种子图谱并汇报统计
      kaleidoscope = buildKaleidoscope();
      return delay<KaleidoscopeRebuildResult>(
        { sources: kaleidoscope.nodes.length, edges: kaleidoscope.edges.length },
        700,
      );
    },

    explainKaleidoscopeEdge: (edgeId) =>
      // mock 无 LLM：固定文案，模拟首次生成的延迟
      delay<KaleidoscopeEdgeExplanation>(
        {
          edgeId,
          explanation: "两条收藏都在讨论如何让收藏的内容重新进入注意力循环：一个从方法论角度论述回看的价值，另一个给出了具体的回看习惯建立方式。",
          cached: false,
          createdAt: nowIso(),
        },
        900,
      ),

    retrieve: (query, topK = 8) => {
      void query;
      const hits = library.cards.slice(0, topK).map((card, index) => ({
        kind: "card" as const,
        card: {
          cardId: card.cardId,
          cardType: card.cardType,
          title: card.title,
          body: card.body,
          domainLabels: card.domainLabels,
        },
        score: Number((0.04 / (index + 1)).toFixed(4)),
        matchedBy: index % 2 === 0 ? (["vector", "fts"] as const).slice() : (["vector"] as const).slice(),
        evidence: {
          sourceId: card.source?.source_id ?? "unknown",
          blocks: card.source?.blocks ?? [],
        },
      }));
      return delay<RetrieveResponse>({ hits, latency_ms: 12 }, 400);
    },

    chat: (query) => {
      // 开放性提问（有什么推荐的 / 有没有什么新鲜的）→ llm 精选 fixture（chat 0.3.0）
      const openQuery = /有什么|有没有|推荐|新鲜|最近|随便|看点|啥|值得|interesting|recommend/i.test(query);
      const noEvidence = /不存在|没有|unknown|unrelated/i.test(query);
      const fixture = (openQuery ? chatOpenQuery : noEvidence ? chatInsufficient : chatAnsweredGo) as ChatTurn;
      const turn: ChatTurn = {
        ...structuredClone(fixture),
        query_id: `query:mock:${Date.now().toString(36)}`,
      };
      if (turn.project_proposal && dismissedProposals.has(turn.project_proposal.proposal_id)) {
        turn.project_proposal = null;
      }
      pushChatHistory(query, turn);
      return delay(turn, 900);
    },

    listChatHistory: () => delay(chatHistory.map((item) => ({ ...item.entry }))),

    getChatTurn: (queryId) => {
      const found = chatHistory.find((item) => item.entry.query_id === queryId);
      return delay(found ? structuredClone(found.turn) : null);
    },

    submitCapture: (request: SubmitCaptureRequest) => {
      const url = request.url.trim();
      const existing = captures.find((item) => item.url === url);
      if (existing) {
        return delay<SubmitCaptureResult>({ capture: { ...existing }, duplicate: true });
      }
      captureCounter += 1;
      const capture: CaptureItem = {
        captureId: `cap_mock_${Date.now().toString(36)}_${captureCounter}`,
        url,
        title: "",
        intent: request.intent,
        status: "idle",
        sourceId: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        archived: false,
        failure: null,
      };
      captures.unshift(capture);
      schedulePipeline(capture);
      return delay<SubmitCaptureResult>({ capture: { ...capture }, duplicate: false });
    },

    listCaptures: () => delay(captures.map((item) => ({ ...item }))),

    updateCaptureIntent: (captureId, intent: CaptureIntent) => {
      const capture = findCapture(captureId);
      capture.intent = intent;
      capture.updatedAt = nowIso();
      return delay({ ...capture });
    },

    retryCapture: (captureId) => {
      const capture = findCapture(captureId);
      capture.failure = null;
      schedulePipeline(capture);
      return delay({ ...capture });
    },

    archiveCapture: (captureId) => {
      const capture = findCapture(captureId);
      capture.archived = true;
      capture.updatedAt = nowIso();
      return delay(undefined);
    },

    getReviewNext,

    confirmProposal: (request) => {
      const mode: ProjectProposalMode = chatAnsweredGo.project_proposal.mode as ProjectProposalMode;
      if (request.decision === "dismiss") {
        dismissedProposals.add(request.proposal_id);
      }
      const linked = chatAnsweredGo.project_proposal.candidate_card_ids;
      return delay<ConfirmProposalResponse>(
        {
          project_id: chatAnsweredGo.project_proposal.project_id,
          mode,
          title: chatAnsweredGo.project_proposal.title,
          linked_card_ids: request.decision === "confirm" ? [...linked] : [],
        },
        500,
      );
    },

    clearLibrary: () => {
      // mock 全部清空：内存数据重置为空库（与 local 模式清空语义一致）
      library = { sources: [], cards: [], nodes: [], edges: [] };
      kaleidoscope = { nodes: [], edges: [] };
      captures.length = 0;
      cardStates.clear();
      chatHistory.length = 0;
      reviewSeen.clear();
      dismissedProposals.clear();
      return delay(undefined);
    },
  };

  return api;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

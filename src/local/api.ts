import { ApiError, type SubmitCaptureOptions, type TuntaApi } from "@/shared/api/client";
import type {
  BackendStatus,
  CaptureIntent,
  CaptureItem,
  ChatHistoryEntry,
  ChatTurn,
  ConfirmProposalResponse,
  KaleidoscopeGraph,
  KaleidoscopeRebuildResult,
  LibraryCard,
  LibraryGraphEdge,
  LibraryGraphNode,
  LibraryResponse,
  LibrarySource,
  PageSnapshot,
  RetrieveResponse,
  ReviewQueueResponse,
  SubmitCaptureRequest,
  SubmitCaptureResult,
} from "@/shared/api/contracts";
import { isExtensionContext } from "@/shared/browser";
import { normalizeUrl } from "@/shared/format";
import { sendMessage } from "@/shared/messages";
import { runChatTurn, selectCardsForOpenQuery } from "./chat";
import { chunkSourceId } from "./chunk";
import { resetCaptureForRetry, resolveCaptureParseWarnings } from "./capture-state";
import { rebuildAllGraphLinks } from "./kaleidoscope";
import {
  getStore,
  type StoredCapture,
  type StoredChunk,
  type StoredDocument,
} from "./store";
import {
  buildParserOutput,
  isBilibiliListUrl,
  isXiaohongshuUrl,
  LIST_CHILD_ORIGIN,
  parserOutputToSource,
  toCaptureParseWarnings,
  type ParserBlockKind,
  type ParserContentType,
  type ParserLocator,
  type ParserProblem,
} from "./parser";
import { callEmbedding } from "./provider";
import { CHUNK_VECTOR_CANDIDATES, FTS_CANDIDATES, retrieveHits, type ChunkVectorHit } from "./retrieve";
import { chooseReviewCandidate, createSingleFlight } from "./review";
import { ensureOriginPermission, isChatConfigured, isEmbeddingConfigured, loadSettings } from "./settings";

function nowIso(): string {
  return new Date().toISOString();
}

const OPEN_QUERY_PATTERN = /有什么|有没有|推荐|新鲜|最近|随便|看点|啥|值得|interesting|recommend/i;

/** chunk 向量召回：查 embeddings 表拿 chunkId 排名，再回 chunks 表取正文。失败只降级不断检索。 */
async function searchChunkHits(queryEmbedding: number[], model: string): Promise<ChunkVectorHit[]> {
  try {
    const hits = await getStore().searchEmbeddings(queryEmbedding, model, CHUNK_VECTOR_CANDIDATES, "chunk");
    if (hits.length === 0) return [];
    const chunkById = new Map<string, StoredChunk>();
    for (const sourceId of new Set(hits.map((hit) => chunkSourceId(hit.ownerId)))) {
      for (const chunk of await getStore().listChunksBySource(sourceId)) chunkById.set(chunk.chunkId, chunk);
    }
    return hits.flatMap((hit) => {
      const chunk = chunkById.get(hit.ownerId);
      return chunk ? [{ chunk, score: hit.score }] : []; // 防御：向量引用的 chunk 已被重新聚合淘汰
    });
  } catch (cause) {
    console.warn("[tunta] chunk 向量召回失败，降级为卡片召回:", cause);
    return [];
  }
}

let captureCounter = 0;

function newCaptureId(): string {
  captureCounter += 1;
  return `cap_local_${Date.now().toString(36)}_${captureCounter}`;
}

function toPublicCapture(capture: StoredCapture): CaptureItem {
  const { stage: _stage, expandLinks: _expandLinks, attempts: _attempts, ...rest } = capture;
  void _stage;
  void _expandLinks;
  void _attempts;
  return rest;
}

async function listPublicCaptures(): Promise<CaptureItem[]> {
  const store = getStore();
  const captures = await store.listCaptures();
  if (!captures.some((capture) => capture.sourceId)) return captures.map(toPublicCapture);

  // Parser Output 才是 warning 的 source of truth；capture 字段只是 Library 展示镜像。
  const documents = new Map((await store.listDocuments()).map((document) => [document.sourceId, document]));
  return captures.map((capture) => {
    const warnings = resolveCaptureParseWarnings(
      capture,
      capture.sourceId ? documents.get(capture.sourceId) : undefined,
    );
    return toPublicCapture({
      ...capture,
      ...(warnings !== undefined ? { parseWarnings: warnings } : {}),
    });
  });
}

// 即时快照入库
const BLOCK_KINDS = new Set([
  "heading",
  "paragraph",
  "list_item",
  "quote",
  "caption",
  "transcript",
  "ocr",
  "code",
  "table",
  "other",
]);
const LOCATOR_KINDS = new Set(["timestamp", "page", "paragraph", "dom", "unknown"]);
const CONTENT_TYPES = new Set(["article", "video", "audio", "image_post", "mixed", "unknown"]);
const PROBLEM_STAGES = new Set(["fetch", "extract", "transcribe", "ocr", "normalize", "store", "unknown"]);


function toParserBlocks(snapshot: PageSnapshot): { kind: ParserBlockKind; text: string; locator: ParserLocator }[] {
  return snapshot.blocks
    .filter((block) => typeof block?.text === "string" && block.text.trim().length > 0)
    .map((block) => ({
      kind: (BLOCK_KINDS.has(block.kind) ? block.kind : "paragraph") as ParserBlockKind,
      text: block.text,
      locator: {
        kind: (LOCATOR_KINDS.has(block.locator?.kind ?? "") ? block.locator.kind : "unknown") as ParserLocator["kind"],
        start_ms: block.locator?.start_ms ?? null,
        end_ms: block.locator?.end_ms ?? null,
        page_number: block.locator?.page_number ?? null,
        paragraph_index: block.locator?.paragraph_index ?? null,
        selector: block.locator?.selector ?? null,
      },
    }));
}

function toParserContentType(value: string): ParserContentType {
  return (CONTENT_TYPES.has(value) ? value : "unknown") as ParserContentType;
}

function toParserWarnings(snapshot: PageSnapshot): ParserProblem[] {
  return (snapshot.warnings ?? [])
    .filter(
      (warning) =>
        typeof warning?.code === "string" &&
        warning.code.trim().length > 0 &&
        typeof warning?.message === "string" &&
        warning.message.trim().length > 0,
    )
    .map((warning) => ({
      code: warning.code.trim(),
      message: warning.message.trim(),
      stage: (PROBLEM_STAGES.has(warning.stage) ? warning.stage : "unknown") as ParserProblem["stage"],
      recoverable: warning.recoverable === true,
    }));
}











function sourceWithCuration(doc: StoredDocument): LibrarySource {
  const source = parserOutputToSource(doc.parserOutput);
  if (doc.curatedTitle) source.metadata.title = doc.curatedTitle;
  if (doc.summary) source.metadata.summary = doc.summary;
  return source;
}

async function buildLibrary(): Promise<LibraryResponse> {
  const [documents, cards] = await Promise.all([getStore().listDocuments(), getStore().listCards()]);
  const sourceById = new Map(documents.map((doc) => [doc.sourceId, sourceWithCuration(doc)]));
  const libraryCards: LibraryCard[] = cards.map((card) => ({
    cardId: card.cardId,
    cardType: card.cardType,
    title: card.title,
    body: card.body,
    domainLabels: card.domainLabels,
    evidence: card.evidence,
    source: sourceById.get(card.sourceId),
  }));

  const nodes: LibraryGraphNode[] = [];
  const edges: LibraryGraphEdge[] = [];
  const domainNodes = new Map<string, string>();
  for (const card of cards) {
    nodes.push({
      node_id: `node:card:${card.cardId}`,
      node_type: "card",
      label: card.title,
      metadata: { card_id: card.cardId, card_type: card.cardType, source_id: card.sourceId },
    });
    for (const label of card.domainLabels) {
      let domainNodeId = domainNodes.get(label);
      if (!domainNodeId) {
        domainNodeId = `node:domain:${label}`;
        domainNodes.set(label, domainNodeId);
        nodes.push({ node_id: domainNodeId, node_type: "domain", label, metadata: {} });
      }
      edges.push({
        edge_id: `edge:${card.cardId}:${label}`,
        edge_type: "belongs_to_domain",
        from_node_id: `node:card:${card.cardId}`,
        to_node_id: domainNodeId,
        evidence_block_refs: card.evidence.map((item) => item.blockId),
        metadata: {},
      });
    }
  }

  return { sources: [...sourceById.values()], cards: libraryCards, nodes, edges };
}
































const REVIEW_SEEN_KEY = "tunta:review-seen";

function loadReviewSeen(): Set<string> {
  try {
    return new Set(JSON.parse(globalThis.localStorage?.getItem(REVIEW_SEEN_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function saveReviewSeen(seen: Set<string>): void {
  globalThis.localStorage?.setItem(REVIEW_SEEN_KEY, JSON.stringify([...seen]));
}

async function loadLocalReviewNext(): Promise<ReviewQueueResponse> {
  const seen = loadReviewSeen();
  const captures = (await getStore().listCaptures()).filter(
    (capture) =>
      capture.intent === "pending" &&
      !capture.archived &&
      capture.status === "done" &&
      !seen.has(capture.captureId),
  );
  const cardsByCapture = await Promise.all(
    captures.map((capture) => (capture.sourceId ? getStore().listCardsBySource(capture.sourceId) : Promise.resolve([]))),
  );
  const selection = chooseReviewCandidate(
    captures.map((capture, index) => ({
      capture: toPublicCapture(capture),
      cards: cardsByCapture[index],
    })),
    seen,
  );
  if (!selection.candidate) {
    return { item: null, remaining: 0 };
  }

  saveReviewSeen(selection.seen);
  const { capture, cards } = selection.candidate;
  const doc = capture.sourceId ? await getStore().getDocument(capture.sourceId) : undefined;
  const first = cards[0];
  return {
    item: {
      capture,
      card: {
        cardId: first.cardId,
        cardType: first.cardType,
        title: first.title,
        body: first.body,
        domainLabels: first.domainLabels,
        evidence: first.evidence,
        source: doc ? sourceWithCuration(doc) : undefined,
      },
      originalUrl: capture.url,
    },
    remaining: selection.remaining,
  };
}




export function createLocalApi(): TuntaApi {
  const getReviewNext = createSingleFlight(loadLocalReviewNext);
  return {
    getStatus: async (): Promise<BackendStatus> => {
      const settings = await loadSettings();
      const embedding = isEmbeddingConfigured(settings);
      return {
        schema_version: "0.2.0",
        intelligence: {
          embedding: embedding ? "real-provider" : "none",
          embedding_dimensions: 0,
          retrieval: embedding ? "vector + fts" : "fts",
        },
        backend: { mode: "local", version: "0.1.0" },
      };
    },

    getLibrary: () => buildLibrary(),

    getKaleidoscope: async (): Promise<KaleidoscopeGraph> => {
      const [documents, cards, edges] = await Promise.all([getStore().listDocuments(), getStore().listCards(), getStore().listKaleidoscopeEdges()]);
      const cardCountBySource = new Map<string, number>();
      for (const card of cards) {
        cardCountBySource.set(card.sourceId, (cardCountBySource.get(card.sourceId) ?? 0) + 1);
      }
      const known = new Set(documents.map((doc) => doc.sourceId));
      return {
        nodes: documents.map((doc) => ({
          sourceId: doc.sourceId,
          title: doc.curatedTitle ?? doc.title,
          summary: doc.summary ?? null,
          platform: doc.platform,
          url: doc.url,
          cardCount: cardCountBySource.get(doc.sourceId) ?? 0,
        })),
        


        edges: edges.filter((edge) => known.has(edge.fromSourceId) && known.has(edge.toSourceId)),
      };
    },

    rebuildKaleidoscope: async (): Promise<KaleidoscopeRebuildResult> => {
      const settings = await loadSettings();
      if (!isChatConfigured(settings)) {
        throw new ApiError("尚未配置 provider：请在工作台「设置」页填写 API key 后再重建关系。", 400, "PROVIDER_NOT_CONFIGURED");
      }
      return rebuildAllGraphLinks(settings);
    },

    retrieve: async (query, topK = 8): Promise<RetrieveResponse> => {
      const started = Date.now();
      const [cards, ftsHits, settings] = await Promise.all([
        getStore().listCards(),
        getStore().searchCardsFts(query, FTS_CANDIDATES),
        loadSettings(),
      ]);
      let queryEmbedding: number[] | null = null;
      let chunkHits: ChunkVectorHit[] = [];
      if (isEmbeddingConfigured(settings)) {
        try {
          [queryEmbedding] = await callEmbedding(settings.embedding, [query]);
        } catch (cause) {
          console.warn("[tunta] 查询向量化失败，退化为纯 FTS:", cause);
        }
        if (queryEmbedding) chunkHits = await searchChunkHits(queryEmbedding, settings.embedding.model);
      }
      const hits = retrieveHits(cards, ftsHits, chunkHits, topK, queryEmbedding, settings.retrieval);
      const documents = new Map((await getStore().listDocuments()).map((doc) => [doc.sourceId, doc]));
      return {
        hits: hits.map((hit) => {
          if (hit.kind === "chunk") {
            const doc = documents.get(hit.chunk.sourceId);
            return {
              kind: "chunk" as const,
              chunk: {
                chunkId: hit.chunk.chunkId,
                sourceId: hit.chunk.sourceId,
                text: hit.chunk.text,
                blockIds: hit.chunk.blockIds,
              },
              score: hit.score,
              matchedBy: hit.matchedBy,
              evidence: {
                sourceId: hit.chunk.sourceId,
                blocks: doc ? parserOutputToSource(doc.parserOutput).blocks : [],
              },
            };
          }
          const doc = documents.get(hit.card.sourceId);
          return {
            kind: "card" as const,
            card: {
              cardId: hit.card.cardId,
              cardType: hit.card.cardType,
              title: hit.card.title,
              body: hit.card.body,
              domainLabels: hit.card.domainLabels,
            },
            score: hit.score,
            matchedBy: hit.matchedBy,
            evidence: {
              sourceId: hit.card.sourceId,
              blocks: doc ? parserOutputToSource(doc.parserOutput).blocks : [],
            },
          };
        }),
        latency_ms: Date.now() - started,
      };
    },

    chat: async (query): Promise<ChatTurn> => {
      const settings = await loadSettings();
      if (!isChatConfigured(settings)) {
        throw new ApiError("尚未配置 provider：请在工作台「设置」页填写 API key 后再提问。", 400, "PROVIDER_NOT_CONFIGURED");
      }
      const [cards, ftsHits] = await Promise.all([getStore().listCards(), getStore().searchCardsFts(query, FTS_CANDIDATES)]);
      let queryEmbedding: number[] | null = null;
      let chunkHits: ChunkVectorHit[] = [];
      if (isEmbeddingConfigured(settings)) {
        try {
          [queryEmbedding] = await callEmbedding(settings.embedding, [query]);
        } catch (cause) {
          console.warn("[tunta] 查询向量化失败，退化为纯 FTS:", cause);
        }
        if (queryEmbedding) chunkHits = await searchChunkHits(queryEmbedding, settings.embedding.model);
      }
      let hits = retrieveHits(cards, ftsHits, chunkHits, 6, queryEmbedding, settings.retrieval);
      
      if (cards.length > 0 && (OPEN_QUERY_PATTERN.test(query) || hits.length < 2)) {
        const curated = await selectCardsForOpenQuery(settings, cards, query);
        if (curated.length > 0) {
          hits = curated;
        } else if (OPEN_QUERY_PATTERN.test(query)) {
          
          hits = [];
        }
      }
      const documents = new Map((await getStore().listDocuments()).map((doc) => [doc.sourceId, doc]));
      const turn = await runChatTurn({ query, hits, documents, settings });
      
      await getStore().putChatTurn({ queryId: turn.query_id, query, createdAt: nowIso(), turn });
      void getStore().pruneChatTurns().catch((cause) => console.warn("[tunta] 历史淘汰失败:", cause));
      return turn;
    },

    listChatHistory: async (): Promise<ChatHistoryEntry[]> =>
      (await getStore().listChatTurns()).map((record) => ({
        query_id: record.queryId,
        query: record.query,
        status: record.turn.status,
        createdAt: record.createdAt,
        answerPreview: record.turn.answer ? record.turn.answer.slice(0, 80) : null,
        citationCount: record.turn.citations.length,
      })),

    getChatTurn: async (queryId): Promise<ChatTurn | null> => (await getStore().getChatTurnRecord(queryId))?.turn ?? null,

    submitCapture: async (request: SubmitCaptureRequest, options?: SubmitCaptureOptions): Promise<SubmitCaptureResult> => {
      if (!isExtensionContext()) {
        throw new ApiError("页面快照只在扩展环境中可用（vite 预览请用 mock 模式）。", 400, "SNAPSHOT_REQUIRES_EXTENSION");
      }
      const url = normalizeUrl(request.url);
      if (isXiaohongshuUrl(url) && !options?.snapshot) {
        throw new ApiError(
          "小红书 local 抓取只读取用户主动打开的当前笔记页：请打开该笔记，再点击插件收藏。",
          400,
          "XHS_ACTIVE_TAB_REQUIRED",
        );
      }
      
      const granted = await ensureOriginPermission(url);
      if (!granted) {
        throw new ApiError("没有获得该站点的访问权限，无法抓取页面快照。", 403, "FETCH_PERMISSION_DENIED");
      }
      

      if (isBilibiliListUrl(url)) {
        await ensureOriginPermission(LIST_CHILD_ORIGIN);
      }
      const existing = await getStore().getCaptureByUrl(url);
      if (existing) {
        return { capture: toPublicCapture(existing), duplicate: true };
      }
      const captureId = newCaptureId();

      

      if (options?.snapshot) {
        const blocks = toParserBlocks(options.snapshot);
        if (blocks.length === 0) {
          throw new ApiError("当前页快照为空：未能提取到正文内容。", 400, "SNAPSHOT_EMPTY");
        }
        const output = await buildParserOutput({
          originalUrl: url,
          finalUrl: options.snapshot.finalUrl || url,
          title: options.snapshot.title || url,
          platform: options.snapshot.platform || "web",
          contentType: toParserContentType(options.snapshot.contentType),
          blocks,
          jobId: `job:${captureId}`,
          author: options.snapshot.author ?? null,
          publishedAt: options.snapshot.publishedAt ?? null,
          warnings: toParserWarnings(options.snapshot),
        });
        const doc: StoredDocument = {
          sourceId: output.source.source_id,
          url: output.source.original_url,
          title: output.source.title ?? url,
          platform: output.source.platform,
          contentHash: output.parse.content_hash ?? "",
          parserOutput: output,
          createdAt: nowIso(),
        };
        await getStore().putDocument(doc);
        const capture: StoredCapture = {
          captureId,
          url,
          title: doc.title,
          intent: request.intent,
          status: "parsing",
          stage: "snapshot",
          sourceId: doc.sourceId,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          archived: false,
          failure: null,
          parseWarnings: toCaptureParseWarnings(output.parse.warnings),
          ...(options.snapshot.listLinks?.length ? { expandLinks: options.snapshot.listLinks } : {}),
        };
        await getStore().putCapture(capture);
        await sendMessage({ type: "tunta:run-pipeline", captureId });
        return { capture: toPublicCapture(capture), duplicate: false };
      }

      const capture: StoredCapture = {
        captureId,
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
      await getStore().putCapture(capture);
      await sendMessage({ type: "tunta:run-pipeline", captureId: capture.captureId, tabId: options?.tabId });
      return { capture: toPublicCapture(capture), duplicate: false };
    },

    listCaptures: listPublicCaptures,

    updateCaptureIntent: async (captureId, intent: CaptureIntent): Promise<CaptureItem> => {
      const capture = await getStore().getCapture(captureId);
      if (!capture) throw new ApiError(`收藏不存在：${captureId}`, 404, "CAPTURE_NOT_FOUND");
      const next = { ...capture, intent, updatedAt: nowIso() };
      await getStore().putCapture(next);
      return toPublicCapture(next);
    },

    retryCapture: async (captureId): Promise<CaptureItem> => {
      const capture = await getStore().getCapture(captureId);
      if (!capture) throw new ApiError(`收藏不存在：${captureId}`, 404, "CAPTURE_NOT_FOUND");
      

      const next = resetCaptureForRetry(capture, nowIso());
      await getStore().putCapture(next);
      await sendMessage({ type: "tunta:run-pipeline", captureId });
      return toPublicCapture(next);
    },

    archiveCapture: async (captureId): Promise<void> => {
      const capture = await getStore().getCapture(captureId);
      if (!capture) throw new ApiError(`收藏不存在：${captureId}`, 404, "CAPTURE_NOT_FOUND");
      await getStore().putCapture({ ...capture, archived: true, updatedAt: nowIso() });
    },

    getReviewNext,

    confirmProposal: async (): Promise<ConfirmProposalResponse> => {
      

      throw new ApiError("插件独立模式暂不支持 Project proposal 编排。", 501, "NOT_SUPPORTED");
    },

    clearLibrary: async (): Promise<void> => {
      
      await getStore().clearAllLocalData();
      globalThis.localStorage?.removeItem(REVIEW_SEEN_KEY);
    },
  };
}

/**
 * Frontend ↔ Backend API 边界。
 *
 * 前端不直接依赖 modules/parser 或 modules/intelligence 的内部对象
 * （见 docs/development-boundaries.md §2），一切数据经 backend HTTP 接口。
 *
 * Backend 尚未实现，下面的路径即 frontend 期望的接口面；prototype
 * （apps/frontend/prototypes/retrieval-connected-test.html）已经消费其中
 * /api/status、/api/library、/api/retrieve、/api/projects/confirm。
 * backend 联调时以这里为对齐起点，变更需同步更新 mock client。
 */
import type {
  BackendStatus,
  CaptureIntent,
  CaptureItem,
  ChatHistoryEntry,
  ChatTurn,
  ConfirmProposalRequest,
  ConfirmProposalResponse,
  KaleidoscopeEdgeExplanation,
  KaleidoscopeGraph,
  KaleidoscopeRebuildResult,
  LibraryResponse,
  PageSnapshot,
  RetrieveResponse,
  ReviewQueueResponse,
  SubmitCaptureRequest,
  SubmitCaptureResult,
} from "./contracts";

/**
 * 收藏提交的调用侧选项。仅 local（插件独立）模式使用：popup 收藏当前页面时
 * 传入活动标签页 id 与即时 DOM 快照（快照已在该页面提取完成，后台不再重新
 * 打开标签页抓取）。real / mock 实现忽略该参数。
 */
export interface SubmitCaptureOptions {
  tabId?: number;
  snapshot?: PageSnapshot;
}

export interface TuntaApi {
  /** GET /api/status */
  getStatus(): Promise<BackendStatus>;
  /** GET /api/library */
  getLibrary(): Promise<LibraryResponse>;
  /** GET /api/kaleidoscope —— 万花筒知识图谱（来源节点 + 实体共现关联边） */
  getKaleidoscope(): Promise<KaleidoscopeGraph>;
  /** POST /api/kaleidoscope/rebuild —— 实体共现纯计算重建（零 provider 调用） */
  rebuildKaleidoscope(): Promise<KaleidoscopeRebuildResult>;
  /** POST /api/kaleidoscope/edges/{edgeId}/explain —— 边解释懒加载（命中缓存零 LLM，计划 §Task3.5） */
  explainKaleidoscopeEdge(edgeId: string): Promise<KaleidoscopeEdgeExplanation>;
  /** POST /api/retrieve { query, top_k } —— 关键词 + 语义混合检索 */
  retrieve(query: string, topK?: number): Promise<RetrieveResponse>;
  /** POST /api/chat { query } —— 调用模式，产出 grounded answer（chat 0.2.0） */
  chat(query: string): Promise<ChatTurn>;
  /** GET /api/chat/history —— 问答历史（App 产品数据，新的在前） */
  listChatHistory(): Promise<ChatHistoryEntry[]>;
  /** GET /api/chat/history/{query_id} —— 加载历史中的完整 ChatTurn */
  getChatTurn(queryId: string): Promise<ChatTurn | null>;
  /** POST /api/captures { url, intent, note? } —— 收藏入口（幂等，重复 URL 不重复入库） */
  submitCapture(request: SubmitCaptureRequest, options?: SubmitCaptureOptions): Promise<SubmitCaptureResult>;
  /** GET /api/captures —— 收藏列表（含处理状态，用于状态可见性与轮询） */
  listCaptures(): Promise<CaptureItem[]>;
  /** POST /api/captures/{id}/intent { intent } —— 修改 待消化/常用 */
  updateCaptureIntent(captureId: string, intent: CaptureIntent): Promise<CaptureItem>;
  /** POST /api/captures/{id}/retry —— 失败重试，不生成重复记录 */
  retryCapture(captureId: string): Promise<CaptureItem>;
  /** POST /api/captures/{id}/archive —— 归档（常用内容归档需二次确认，由 UI 保证） */
  archiveCapture(captureId: string): Promise<void>;
  /** GET /api/review/next —— 回看队列，带去重的随机策略 */
  getReviewNext(): Promise<ReviewQueueResponse>;
  /** POST /api/projects/confirm —— Chat proposal 的用户确认/抑制编排 */
  confirmProposal(request: ConfirmProposalRequest): Promise<ConfirmProposalResponse>;
  /** POST /api/admin/clear —— 清空本机知识库数据（收藏/原文/卡片/问答历史），保留 provider 设置 */
  clearLibrary(): Promise<void>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ---------------------------------------------------------------------------
// 真实 backend 实现
// ---------------------------------------------------------------------------

interface ErrorPayload {
  error?: { code?: string; message?: string };
}

export function createRealApi(baseUrl: string): TuntaApi {
  const base = baseUrl.replace(/\/+$/, "");

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const error = (payload as ErrorPayload | null)?.error;
      throw new ApiError(
        error?.message ?? `${response.status} ${response.statusText}`,
        response.status,
        error?.code,
      );
    }
    return payload as T;
  }

  return {
    getStatus: () => request<BackendStatus>("/api/status"),
    getLibrary: () => request<LibraryResponse>("/api/library"),
    getKaleidoscope: () => request<KaleidoscopeGraph>("/api/kaleidoscope"),
    rebuildKaleidoscope: () =>
      request<KaleidoscopeRebuildResult>("/api/kaleidoscope/rebuild", { method: "POST" }),
    explainKaleidoscopeEdge: (edgeId) =>
      request<KaleidoscopeEdgeExplanation>(`/api/kaleidoscope/edges/${encodeURIComponent(edgeId)}/explain`, {
        method: "POST",
      }),
    retrieve: (query, topK = 8) =>
      request<RetrieveResponse>("/api/retrieve", {
        method: "POST",
        body: JSON.stringify({ query, top_k: topK }),
      }),
    chat: (query) =>
      request<ChatTurn>("/api/chat", {
        method: "POST",
        body: JSON.stringify({ query }),
      }),
    listChatHistory: () => request<ChatHistoryEntry[]>("/api/chat/history"),
    getChatTurn: (queryId) =>
      request<ChatTurn | null>(`/api/chat/history/${encodeURIComponent(queryId)}`),
    submitCapture: (body, options) => {
      void options; // tabId 只用于 local 模式的页面快照
      return request<SubmitCaptureResult>("/api/captures", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    listCaptures: () => request<CaptureItem[]>("/api/captures"),
    updateCaptureIntent: (captureId, intent) =>
      request<CaptureItem>(`/api/captures/${encodeURIComponent(captureId)}/intent`, {
        method: "POST",
        body: JSON.stringify({ intent }),
      }),
    retryCapture: (captureId) =>
      request<CaptureItem>(`/api/captures/${encodeURIComponent(captureId)}/retry`, {
        method: "POST",
      }),
    archiveCapture: (captureId) =>
      request<void>(`/api/captures/${encodeURIComponent(captureId)}/archive`, {
        method: "POST",
      }),
    getReviewNext: () => request<ReviewQueueResponse>("/api/review/next"),
    confirmProposal: (body) =>
      request<ConfirmProposalResponse>("/api/projects/confirm", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    clearLibrary: () => request<void>("/api/admin/clear", { method: "POST" }),
  };
}

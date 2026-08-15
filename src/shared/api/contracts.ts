/**
 * 前端消费的 API 数据模型。
 *
 * 两类来源：
 * 1. 跨模块合同（contracts/）：Chat turn 严格镜像
 *    `contracts/intelligence-chat/0.3.0/schema.json`（snake_case）。backend
 *    尚未升级时仍可能交付 0.2.0，schema_version 以联合类型接收。
 * 2. App 级 payload（library / retrieve / captures / review）：属于
 *    backend 对 App 的产品接口，沿用 prototype（retrieval-connected-test.html）
 *    已经消费的 camelCase 形态。App 侧状态（intent / archive / 已读）
 *    不写回 Intelligence Output。
 *
 * backend 尚未实现时，这些类型即 frontend 对 backend 的期望接口，字段调整
 * 需要在这里和 mock client 同步收口。
 */

// ---------------------------------------------------------------------------
// contracts/intelligence-chat/0.3.0（snake_case，镜像 schema；兼容 0.2.0）
// ---------------------------------------------------------------------------

export type ChatStatus = "answered" | "insufficient_evidence";

export type CardType = "insight" | "quote" | "method" | "question" | "action";

/** 0.3.0 起新增 llm：模型从收藏库概览中直接精选（开放性提问），score 约定为 0。 */
export type MatchedBy = "vector" | "fts" | "llm";

export interface ChatLocator {
  kind: "timestamp" | "page" | "paragraph" | "dom" | "unknown";
  start_ms: number | null;
  end_ms: number | null;
  page_number: number | null;
  paragraph_index: number | null;
  selector: string | null;
}

/** 引用证据的来源层级：card = 已提炼卡片；chunk = 原文片段（未经提炼）兜底。 */
export type CitationSourceKind = "card" | "chunk";

export interface ChatCitation {
  marker: number;
  /** 本地扩展字段（schema 0.3.0 尚未收录）；存量历史 turn 缺失时按 "card" 处理。 */
  source_kind: CitationSourceKind;
  /** source_kind 为 chunk 时为 null（命中的是原文片段，不对应任何卡片）。 */
  card_id: string | null;
  source_id: string;
  block_id: string;
  quote: string | null;
  original_url: string | null;
  locator: ChatLocator;
}

export interface RetrievedCard {
  card_id: string;
  card_type: CardType;
  title: string;
  body: string;
  domain_labels: string[];
  score: number;
  matched_by: MatchedBy[];
}

export interface ProjectSummary {
  title: string;
  description: string;
}

export interface SimilarProject {
  project_id: string;
  title: string;
  description: string;
  score: number;
}

export type ProjectProposalMode = "add" | "go";

export interface ProjectProposal {
  proposal_id: string;
  project_id: string;
  revision: 1;
  mode: ProjectProposalMode;
  title: string;
  intent: string;
  candidate_card_ids: string[];
  rationale: string;
  matched_project: ProjectSummary | null;
  similar_projects: SimilarProject[];
}

export interface ChatGeneration {
  provider: string;
  model: string;
  latency_ms: number;
}

/** contracts/intelligence-chat 的单轮输出（0.3.0；0.2.0 仅差 matched_by 枚举）。 */
export interface ChatTurn {
  schema_version: "0.2.0" | "0.3.0";
  query_id: string;
  status: ChatStatus;
  answer: string | null;
  citations: ChatCitation[];
  retrieved_cards: RetrievedCard[];
  project_proposal: ProjectProposal | null;
  generation: ChatGeneration;
}

// ---------------------------------------------------------------------------
// App 级 payload（camelCase，沿用 prototype 消费形态）
// ---------------------------------------------------------------------------

/** backend 证据解析后的原文 block（对应 Parser Output 的 block）。 */
export interface SourceBlock {
  blockId: string;
  kind: string;
  text: string;
  locator: {
    kind: "timestamp" | "page" | "paragraph" | "dom" | "unknown";
    startMs?: number;
    endMs?: number;
    pageNumber?: number;
    paragraphIndex?: number;
    selector?: string;
  };
}

export interface LibrarySource {
  source_id: string;
  originalUrl: string;
  metadata: {
    title?: string;
    [key: string]: unknown;
  };
  blocks: SourceBlock[];
}

/** 对应 contracts/intelligence-output 的 card，App 侧附加 source 上下文。 */
export interface LibraryCard {
  cardId: string;
  cardType: CardType;
  title: string;
  body: string;
  domainLabels: string[];
  evidence: { blockId: string; quote?: string | null }[];
  source?: LibrarySource;
  /** 卡片创建时间（ISO）；卡片流按此倒序。旧 mock 种子数据可能缺失。 */
  createdAt?: string;
}

export interface LibraryGraphNode {
  node_id: string;
  node_type: "card" | "domain" | "project";
  label: string;
  metadata: Record<string, unknown>;
}

export interface LibraryGraphEdge {
  edge_id: string;
  edge_type: "belongs_to_domain" | "belongs_to_project";
  from_node_id: string;
  to_node_id: string;
  evidence_block_refs: string[];
  metadata: Record<string, unknown>;
}

export interface LibraryResponse {
  sources: LibrarySource[];
  cards: LibraryCard[];
  nodes: LibraryGraphNode[];
  edges: LibraryGraphEdge[];
}

/**
 * 卡片上的用户状态（计划 §Task5.2）：star/隐藏/笔记。App 产品数据，
 * 与卡片本体分离：策展重跑不丢状态（cardId 内容派生保证不错位）。
 */
export interface CardStateInfo {
  cardId: string;
  starred: boolean;
  hidden: boolean;
  userNote: string | null;
  reviewCount: number;
  lastReviewedAt: string | null;
  updatedAt: string;
}

/** 部分更新：未传字段保持原值；userNote 传 null 表示清空笔记。 */
export interface UpdateCardStateRequest {
  starred?: boolean;
  hidden?: boolean;
  userNote?: string | null;
}

/**
 * 实体 mention 连接记录（计划 §Task5.3）：实体（索引）→ 卡片（内容）→ 来源（出处）。
 * 软合并的实体已归到 canonical 名下；n 小，前端自行与 getLibrary 的卡片 join。
 */
export interface EntityMentionInfo {
  entityId: string;
  entityName: string;
  entityType: string;
  /** hub = 高频泛化实体（计划 §Task3.3）：侧栏展示时降权排序。 */
  isHub: boolean;
  cardId: string;
  sourceId: string;
  blockId: string | null;
}

// ---------------------------------------------------------------------------
// Kaleidoscope 万花筒（App 级知识图谱：来源之间的实体共现关联）
// ---------------------------------------------------------------------------

/** 万花筒节点：一条收藏来源（文档粒度，卡片数作为节点权重）。 */
export interface KaleidoscopeNode {
  sourceId: string;
  title: string;
  summary: string | null;
  platform: string;
  url: string;
  cardCount: number;
}

/** 万花筒边：从实体共现派生的来源间关联（纯计算，App 产品数据）。 */
export interface KaleidoscopeEdge {
  edgeId: string;
  fromSourceId: string;
  toSourceId: string;
  /** 关系短语（如「同属个人知识管理方法论」） */
  relation: string;
  /** 关联强度 0~1 */
  strength: number;
  createdAt: string;
}

export interface KaleidoscopeGraph {
  nodes: KaleidoscopeNode[];
  edges: KaleidoscopeEdge[];
}

/**
 * 概念图节点：一个实体。这是万花筒的默认视图——实体是索引、卡片是内容、来源是出处。
 * hub（出现在 >30% 卡片的泛化实体）不进图，只在侧栏保留为标签。
 */
export interface KaleidoscopeEntityNode {
  entityId: string;
  name: string;
  type: string;
  /** 覆盖卡片数（mentions 主键保证每实体每卡至多一条） */
  mentionCount: number;
  /** 跨来源数：一个概念被多少条不同收藏提到，跨源才是知识而不是相似度 */
  sourceCount: number;
}

/** 概念图边：实体共现（纯计算，零 LLM）。strength 由 cooccurCount 归一化而来。 */
export interface KaleidoscopeEntityEdge {
  edgeId: string;
  aId: string;
  bId: string;
  cooccurCount: number;
  pmi: number | null;
  strength: number;
}

/**
 * 概念图。nodes 已按 mentionCount 截断到 nodeLimit——
 * cytoscape 渲染上千节点会糊成毛球，截断是必须的（计划 §4「节点上限」）。
 */
export interface KaleidoscopeEntityGraph {
  nodes: KaleidoscopeEntityNode[];
  edges: KaleidoscopeEntityEdge[];
  /** 截断前的非 hub 实体总数，用于告诉用户「这不是全部」 */
  totalEntities: number;
  nodeLimit: number;
}

/** 重建万花筒关系网络的结果统计（实体共现纯计算，零 provider 调用）。 */
export interface KaleidoscopeRebuildResult {
  sources: number;
  edges: number;
}

/** 边解释（计划 §Task3.5）：点开边时才调 LLM 生成，cached 表示本次命中缓存。 */
export interface KaleidoscopeEdgeExplanation {
  edgeId: string;
  explanation: string;
  cached: boolean;
  createdAt: string;
}

/**
 * 检索命中的联合形态：card 是已过质量判断的提炼结果，chunk 是
 * 「AI 没提炼但原文有」的兜底（同分时卡片排在 chunk 前）。
 */
export type RetrieveHit =
  | {
      kind: "card";
      card: {
        cardId: string;
        cardType: CardType;
        title: string;
        body: string;
        domainLabels: string[];
      };
      score: number;
      matchedBy: MatchedBy[];
      evidence: {
        sourceId: string;
        blocks: SourceBlock[];
      };
    }
  | {
      kind: "chunk";
      chunk: {
        chunkId: string;
        sourceId: string;
        text: string;
        blockIds: string[];
      };
      score: number;
      matchedBy: MatchedBy[];
      evidence: {
        sourceId: string;
        blocks: SourceBlock[];
      };
    };

export interface RetrieveResponse {
  hits: RetrieveHit[];
  latency_ms: number;
}

// ---------------------------------------------------------------------------
// 收藏与回看（App 产品数据）
// ---------------------------------------------------------------------------

/** 收藏意图：待消化（进入回看队列）或 常用（独立入口，不参与默认清理）。 */
export type CaptureIntent = "pending" | "favorite";

/** 顶栏与收藏库共用同一份意图选项，避免两处文案漂移。 */
export const CAPTURE_INTENT_OPTIONS: { value: CaptureIntent; label: string }[] = [
  { value: "pending", label: "待消化" },
  { value: "favorite", label: "常用" },
];

/**
 * 处理状态。README 要求对用户可见的五态：idle / fetching / parsing / done / failed。
 * backend 内部的 ready / archived 也映射到这组 UI 状态。
 */
export type CaptureStatus = "idle" | "fetching" | "parsing" | "done" | "failed";

export interface CaptureFailure {
  code: string;
  message: string;
  /** 失败阶段：fetch / parse / generate / store / unknown */
  stage: string;
  recoverable: boolean;
}

/** Parser 的非致命问题；独立于 AI 策展结论，避免抓取诊断被 curationNote 覆盖。 */
export interface CaptureParseWarning {
  code: string;
  message: string;
  stage: "fetch" | "extract" | "transcribe" | "ocr" | "normalize" | "store" | "unknown";
  recoverable: boolean;
}

export interface CaptureItem {
  captureId: string;
  url: string;
  title: string;
  intent: CaptureIntent;
  status: CaptureStatus;
  sourceId: string | null;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  failure: CaptureFailure | null;
  /** AI 策展 / 列表展开结论（如「不产卡片的原因」「已展开为 N 个子收藏」）；有卡片时为空 */
  curationNote?: string;
  /** 抓取 / 解析链路的结构化非致命告警；不能被后续 AI 策展覆盖。 */
  parseWarnings?: CaptureParseWarning[];
}

export interface SubmitCaptureRequest {
  url: string;
  intent: CaptureIntent;
  note?: string;
}

/**
 * 当前页面的即时 DOM 快照（local 模式）：popup 收藏当前页时直接在活动标签页
 * 执行提取并随收藏提交，后台不再重新打开标签页抓取——用户已加载 / 已滚动
 * 到的页面状态（含登录态、无限滚动内容）即收藏所得。字段为宽松镜像，
 * local 侧入库前会收窄校验。
 */
export interface PageSnapshotBlock {
  kind: string;
  text: string;
  locator: {
    kind: string;
    start_ms?: number | null;
    end_ms?: number | null;
    page_number?: number | null;
    paragraph_index?: number | null;
    selector?: string | null;
  };
}

export interface PageSnapshotWarning extends CaptureParseWarning {}

export interface PageSnapshot {
  finalUrl: string;
  title: string;
  platform: string;
  contentType: "article" | "video" | "audio" | "image_post" | "mixed" | "unknown";
  blocks: PageSnapshotBlock[];
  /** 作者（B 站 UP 主等） */
  author?: string | null;
  publishedAt?: string | null;
  /** 列表页（B 站收藏夹等）展开出的子项目链接；非列表页为空 */
  listLinks?: string[];
  /** 降级说明（如无字幕视频仅收录标题+简介）：标记需要 helper */
  degradedNote?: string;
  /** OCR 待处理图片（已在页面上下文缩放转 base64）；仅图片 OCR 开启时携带。 */
  images?: { url: string; dataUrl: string }[];
  /** Parser 可消费但不完整时的结构化 warning；入库后 parse.status 为 partial。 */
  warnings?: PageSnapshotWarning[];
}

export interface SubmitCaptureResult {
  capture: CaptureItem;
  /** URL 已在库中时不重复入库，返回现有记录。 */
  duplicate: boolean;
}

/** 回看队列条目：一张待消化收藏 + 其主卡片与原文入口。 */
export interface ReviewItem {
  capture: CaptureItem;
  card: LibraryCard;
  originalUrl: string;
}

export interface ReviewQueueResponse {
  item: ReviewItem | null;
  remaining: number;
}

export interface ConfirmProposalRequest {
  proposal_id: string;
  decision: "confirm" | "dismiss";
}

export interface ConfirmProposalResponse {
  project_id: string;
  mode: ProjectProposalMode;
  title: string;
  linked_card_ids: string[];
}

/**
 * 问答历史条目（App 产品数据，与 swipe / 收藏状态同类，不写回合同）。
 * 列表展示用摘要；完整 ChatTurn 经 getChatTurn(query_id) 加载。
 */
export interface ChatHistoryEntry {
  query_id: string;
  query: string;
  status: ChatStatus;
  createdAt: string;
  /** answer 开头片段；insufficient_evidence 时为 null */
  answerPreview: string | null;
  citationCount: number;
}

/**
 * 运行状态，用于顶栏 runtime chips 与连接指示灯。
 * backend.mode = local 表示「插件独立模式」：抓取 / 卡片 / 检索 / 问答全部
 * 在扩展内完成（IndexedDB + 用户配置的 provider），不依赖 helper。
 */
export interface BackendStatus {
  schema_version: string;
  intelligence: {
    /** none = 未配置 embedding provider，退化为纯 FTS 检索 */
    embedding: "real-provider" | "local" | "mock" | "none";
    embedding_dimensions: number;
    retrieval: string;
  };
  backend: {
    mode: "real" | "mock" | "local";
    version: string;
  };
}

// SW/popup ↔ offscreen 之间的正文解析 RPC 协议（计划 §Task4.1）。
// SW 里没有 DOMParser，Readability 只能在 offscreen 文档里跑；
// 页面注入脚本只抓 outerHTML，解析逻辑集中在 offscreen 一处。

export const PARSE_RPC_TARGET = "tunta-parse";

export interface ArticleParseRequest {
  target: typeof PARSE_RPC_TARGET;
  op: "article";
  html: string;
  /** 页面 URL，Readability 需要它解析相对链接。 */
  url: string;
}

/** kind 是 ParserBlockKind 的子集，保持 shared 层不反向依赖 local。 */
export interface ArticleParseBlock {
  kind: "heading" | "paragraph" | "list_item" | "quote" | "code" | "caption";
  text: string;
}

export interface ArticleParseResult {
  title: string | null;
  author: string | null;
  publishedAt: string | null;
  blocks: ArticleParseBlock[];
  /** readability = 正文识别成功；dom-fallback = 退回整页扫描（噪音可能更多）。 */
  parserName: "readability" | "dom-fallback";
}

export type ArticleParseResponse =
  | { ok: true; value: ArticleParseResult }
  | { ok: false; error: string };

// ---- PDF（计划 §Task4.2）----
// Chrome 内置 PDF 查看器是插件，executeScript 拿不到内容；
// 扩展 fetch 原始字节后以 base64 传给 offscreen，pdfjs 在那里解析。

export interface PdfParseRequest {
  target: typeof PARSE_RPC_TARGET;
  op: "pdf";
  /** PDF 原始字节的 base64（扩展消息通道不能直传 Uint8Array）。 */
  data: string;
}

export interface PdfParseBlock {
  text: string;
  pageNumber: number;
}

export interface PdfParseResult {
  title: string | null;
  pageCount: number;
  blocks: PdfParseBlock[];
  /** 超长 PDF 被截断（块数达上限）。 */
  truncated: boolean;
}

export type PdfParseResponse =
  | { ok: true; value: PdfParseResult }
  | { ok: false; error: string };

export type ParseRpcRequest = ArticleParseRequest | PdfParseRequest;

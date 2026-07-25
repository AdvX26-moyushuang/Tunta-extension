import type { LibrarySource, SourceBlock } from "@/shared/api/contracts";

export interface ParserLocator {
  kind: "timestamp" | "page" | "paragraph" | "dom" | "unknown";
  start_ms?: number | null;
  end_ms?: number | null;
  page_number?: number | null;
  paragraph_index?: number | null;
  selector?: string | null;
}

export type ParserBlockKind =
  | "heading"
  | "paragraph"
  | "list_item"
  | "quote"
  | "caption"
  | "transcript"
  | "ocr"
  | "code"
  | "table"
  | "other";

export type ParserContentType = "article" | "video" | "audio" | "image_post" | "mixed" | "unknown";

export interface ParserBlock {
  block_id: string;
  order: number;
  kind: ParserBlockKind;
  text: string;
  parent_block_id: string | null;
  locator: ParserLocator;
  asset_ids: string[];
  metadata: Record<string, unknown>;
}

export interface ParserProblem {
  code: string;
  message: string;
  stage: "fetch" | "extract" | "transcribe" | "ocr" | "normalize" | "store" | "unknown";
  recoverable: boolean;
  details?: Record<string, unknown>;
}

export interface ParserOutput {
  schema_version: "0.1.0";
  source: {
    source_id: string;
    original_url: string;
    canonical_url: string | null;
    platform: string;
    content_type: ParserContentType;
    title: string | null;
    author: string | null;
    published_at: string | null;
    fetched_at: string;
    language: string | null;
    raw_content_ref: string | null;
  };
  blocks: ParserBlock[];
  assets: [];
  parse: {
    job_id: string;
    parser_name: string;
    parser_version: string;
    status: "completed" | "partial" | "failed";
    parsed_at: string;
    content_hash: string | null;
    warnings: ParserProblem[];
    errors: ParserProblem[];
  };
}


export interface ArticleSnapshotBlock {
  kind: "heading" | "paragraph" | "list_item" | "quote" | "code";
  text: string;
}

export type ArticleSnapshotResult =
  | { ok: true; url: string; title: string; blocks: ArticleSnapshotBlock[] }
  | { ok: false; code: string; message: string };

export function extractArticleSnapshot(): ArticleSnapshotResult {
  const url = location.href;
  const title = (document.title || "").trim() || url;
  const root =
    document.querySelector("article") ??
    document.querySelector("main") ??
    document.querySelector("[role=main]") ??
    document.body;
  const blocks: { kind: "heading" | "paragraph" | "list_item" | "quote" | "code"; text: string }[] = [];
  const seen = new Set<string>();
  const push = (kind: (typeof blocks)[number]["kind"], raw: string) => {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    blocks.push({ kind, text: text.slice(0, 2000) });
  };
  const nodes = root.querySelectorAll("h1,h2,h3,p,li,blockquote,pre");
  for (const node of Array.from(nodes)) {
    const tag = node.tagName.toLowerCase();
    const text = (node as HTMLElement).innerText ?? "";
    const isHeading = /^h[123]$/.test(tag);
    if (!isHeading && text.replace(/\s+/g, " ").trim().length < 30) continue;
    push(isHeading ? "heading" : tag === "li" ? "list_item" : tag === "blockquote" ? "quote" : tag === "pre" ? "code" : "paragraph", text);
    if (blocks.length >= 160) break;
  }
  if (blocks.length < 3 && document.body) {
    for (const line of (document.body.innerText ?? "").split(/\n+/)) {
      const text = line.trim();
      if (text.length >= 30) push("paragraph", text);
      if (blocks.length >= 80) break;
    }
  }
  if (blocks.length === 0) {
    return { ok: false, code: "EXTRACT_EMPTY", message: "未能从页面提取到正文内容。" };
  }
  return { ok: true, url, title, blocks };
}

export interface XiaohongshuSnapshotBlock {
  kind: "heading" | "caption";
  text: string;
  selector: string;
}

export type XiaohongshuSnapshotResult =
  | {
      ok: true;
      url: string;
      canonicalUrl: string;
      title: string;
      author: string | null;
      publishedAt: string | null;
      contentType: "article" | "video" | "image_post";
      blocks: XiaohongshuSnapshotBlock[];
      mediaCount: number;
    }
  | { ok: false; code: string; message: string };
  

export function extractXiaohongshuSnapshot(): XiaohongshuSnapshotResult {
  const pageUrl = location.href;
  const parsedUrl = new URL(pageUrl);
  const isXhsHost =
    /(^|\.)xiaohongshu\.com$/i.test(parsedUrl.hostname) || /(^|\.)xhs\.cn$/i.test(parsedUrl.hostname);
  const isNotePath =
    /^\/explore\/[^/]+/.test(parsedUrl.pathname) ||
    /^\/discovery\/item\/[^/]+/.test(parsedUrl.pathname) ||
    (/(^|\.)xhs\.cn$/i.test(parsedUrl.hostname) && parsedUrl.pathname !== "/");
  if (!isXhsHost || !isNotePath) {
    return {
      ok: false,
      code: "XHS_NOT_NOTE",
      message: "当前页面不是可识别的小红书公开笔记页，请打开单条笔记后重试。",
    };
  }

  type JsonRecord = Record<string, unknown>;
  const normalizeText = (raw: string): string => raw.replace(/\s+/g, " ").trim();
  const firstText = (
    selectors: string[],
  ): { text: string; selector: string } | null => {
    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of Array.from(nodes)) {
        const text = normalizeText((node as HTMLElement).innerText ?? node.textContent ?? "");
        if (text) return { text, selector };
      }
    }
    return null;
  };
  const metaContent = (selector: string): string => {
    const value = document.querySelector(selector)?.getAttribute("content") ?? "";
    return normalizeText(value);
  };
  const objectValue = (value: unknown): JsonRecord | null =>
    value != null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
  const stringValue = (value: unknown): string => (typeof value === "string" ? normalizeText(value) : "");
  const normalizeDate = (value: string): string | null => {
    if (!value) return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  };

  let structured: JsonRecord | null = null;
  for (const node of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const raw = JSON.parse(node.textContent ?? "") as unknown;
      const candidates = Array.isArray(raw)
        ? raw
        : objectValue(raw)?.["@graph"] && Array.isArray(objectValue(raw)?.["@graph"])
          ? (objectValue(raw)?.["@graph"] as unknown[])
          : [raw];
      const match = candidates
        .map(objectValue)
        .find((item) => item && (stringValue(item.headline) || stringValue(item.articleBody) || stringValue(item.description)));
      if (match) {
        structured = match;
        break;
      }
    } catch {
    }
  }

  const titleFromDom = firstText(["#detail-title", ".note-content .title", ".note-title"]);
  const structuredTitle = stringValue(structured?.headline) || stringValue(structured?.name);
  const openGraphTitle = metaContent('meta[property="og:title"]');
  const documentTitle = normalizeText((document.title || "").replace(/\s*-\s*小红书.*$/i, ""));
  const titleFromMetadata = structuredTitle
    ? { text: structuredTitle, selector: 'script[type="application/ld+json"]' }
    : openGraphTitle
      ? { text: openGraphTitle, selector: 'meta[property="og:title"]' }
      : documentTitle
        ? { text: documentTitle, selector: "title" }
        : null;
  const title = titleFromDom?.text || titleFromMetadata?.text || "";

  const contentSelectors = [
    "#detail-desc .note-text",
    ".desc .note-text",
    ".note-content .note-text",
    "#detail-desc",
  ];
  const contents: { text: string; selector: string }[] = [];
  const seenContent = new Set<string>();
  for (const selector of contentSelectors) {
    for (const node of Array.from(document.querySelectorAll(selector))) {
      const text = normalizeText((node as HTMLElement).innerText ?? node.textContent ?? "");
      if (!text || seenContent.has(text)) continue;
      seenContent.add(text);
      contents.push({ text, selector });
    }
    if (contents.length > 0) break;
  }
  if (contents.length === 0) {
    const structuredContent = stringValue(structured?.articleBody) || stringValue(structured?.description);
    const openGraphContent = metaContent('meta[property="og:description"]');
    const descriptionContent = metaContent('meta[name="description"]');
    const metadataContent = structuredContent
      ? { text: structuredContent, selector: 'script[type="application/ld+json"]' }
      : openGraphContent
        ? { text: openGraphContent, selector: 'meta[property="og:description"]' }
        : descriptionContent
          ? { text: descriptionContent, selector: 'meta[name="description"]' }
          : null;
    if (metadataContent) {
      contents.push({
        text: metadataContent.text,
        selector: metadataContent.selector,
      });
    }
  }
  if (contents.length === 0) {
    return {
      ok: false,
      code: "XHS_NOTE_EMPTY",
      message: "小红书笔记正文不可见或尚未加载；未读取登录态接口，也不会用页面杂项文本兜底。",
    };
  }

  const authorFromDom = firstText([
    ".author-container .username",
    ".info .username",
    ".author-name",
    ".note-content .author .name",
  ]);
  const structuredAuthor = objectValue(structured?.author);
  const author =
    authorFromDom?.text ||
    stringValue(structuredAuthor?.name) ||
    metaContent('meta[name="author"]') ||
    null;
  const publishedAt =
    normalizeDate(stringValue(structured?.datePublished)) ||
    normalizeDate(metaContent('meta[property="article:published_time"]'));

  const mediaSelectors = [
    ".slider-container img",
    ".note-gallery img",
    ".note-content img",
    ".note-content video",
    'meta[property="og:image"]',
    'meta[property="og:video"]',
  ];
  let imageCount = 0;
  let videoCount = 0;
  for (const selector of mediaSelectors) {
    const count = document.querySelectorAll(selector).length;
    if (selector.includes("video")) videoCount += count;
    else imageCount += count;
  }
  if (structured?.image) imageCount += 1;
  if (structured?.video) videoCount += 1;
  const contentType = videoCount > 0 ? "video" : imageCount > 0 ? "image_post" : "article";

  const canonical = new URL(pageUrl);
  canonical.search = "";
  canonical.hash = "";
  const blocks: XiaohongshuSnapshotBlock[] = [];
  if (title) {
    blocks.push({
      kind: "heading",
      text: title.slice(0, 2000),
      selector: titleFromDom?.selector ?? titleFromMetadata?.selector ?? "title",
    });
  }
  for (const item of contents.slice(0, 80)) {
    blocks.push({ kind: "caption", text: item.text.slice(0, 2000), selector: item.selector });
  }

  return {
    ok: true,
    url: pageUrl,
    canonicalUrl: canonical.href,
    title: title || "小红书笔记",
    author,
    publishedAt,
    contentType,
    blocks,
    mediaCount: imageCount + videoCount,
  };
}

export interface SubtitleCue {
  startMs: number;
  endMs: number;
  text: string;
}

export type BilibiliSnapshotResult =
  | {
      ok: true;
      url: string;
      title: string;
      author: string | null;
      cues: SubtitleCue[];
      degraded?: "no-subtitle" | "subtitle-fetch-failed";
      description?: string;
    }
  | { ok: false; code: string; message: string };


export async function extractBilibiliSnapshot(): Promise<BilibiliSnapshotResult> {
  const url = location.href;
  type BilibiliVideoData = {
    title?: string;
    desc?: string;
    cid?: number;
    owner?: { name?: string };
    pages?: { cid?: number; page?: number }[];
  };
  const initial = (
    window as unknown as {
      __INITIAL_STATE__?: {
        videoData?: BilibiliVideoData;
      };
    }
  ).__INITIAL_STATE__;
  let video = initial?.videoData;
  const playinfo = (window as unknown as { __playinfo__?: { data?: { subtitle?: { subtitles?: unknown } } } }).__playinfo__;
  const bvid = /\/video\/(BV[0-9A-Za-z]+)/.exec(url)?.[1] ?? null;
  let metadataApiError: string | null = null;

  

  if (!video && bvid) {
    try {
      const response = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
        credentials: "include",
      });
      if (!response.ok) {
        metadataApiError = `view API HTTP ${response.status}`;
      } else {
        const json = (await response.json()) as { code?: number; message?: string; data?: BilibiliVideoData };
        if (json.code === 0 && json.data) {
          video = json.data;
        } else {
          metadataApiError = `view API code ${String(json.code ?? "unknown")}: ${json.message ?? "missing data"}`;
        }
      }
    } catch (cause) {
      metadataApiError = `view API request failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }

  const title = (video?.title ?? (document.title || "").replace(/_哔哩哔哩_bilibili\s*$/, "").trim()) || url;
  const author = video?.owner?.name?.trim() || null;
  const description = (video?.desc ?? "").trim();
  const makeDegraded = (kind: "no-subtitle" | "subtitle-fetch-failed"): BilibiliSnapshotResult => ({
    ok: true,
    url,
    title,
    author,
    cues: [],
    degraded: kind,
    description,
  });

  if (!video && !playinfo) {
    return {
      ok: false,
      code: "EXTRACT_NO_RESULT",
      message: `B 站页面元数据不可用（__INITIAL_STATE__、__playinfo__ 与 view API 均无结果）${
        metadataApiError ? `：${metadataApiError}` : "。"
      }`,
    };
  }

  
  type SubtitleEntry = { lan?: string; subtitle_url?: string };
  let entries = Array.isArray(playinfo?.data?.subtitle?.subtitles)
    ? (playinfo.data!.subtitle!.subtitles as SubtitleEntry[])
    : [];

    
  if (entries.length === 0) {
    const pageNo = Math.max(1, Number(new URLSearchParams(location.search).get("p") ?? "1") || 1);
    const cid = video?.pages?.[pageNo - 1]?.cid ?? video?.cid ?? null;
    if (bvid && cid) {
      try {
        const response = await fetch(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`, {
          credentials: "include",
        });
        if (response.ok) {
          const json = (await response.json()) as { data?: { subtitle?: { subtitles?: SubtitleEntry[] } } };
          if (Array.isArray(json?.data?.subtitle?.subtitles)) {
            entries = json.data.subtitle.subtitles;
          }
        }
      } catch {
        
      }
    }
  }

  if (entries.length === 0) {
    return makeDegraded("no-subtitle");
  }

  const preferred = entries.find((item) => /zh|中文|ai-zh/i.test(item.lan ?? "")) ?? entries[0];
  const rawUrl = preferred.subtitle_url ?? "";
  if (!rawUrl) {
    return makeDegraded("no-subtitle");
  }
  const subtitleUrl = rawUrl.startsWith("http") ? rawUrl : `https:${rawUrl}`;
  let body: { from?: number; to?: number; content?: string }[];
  try {
    const response = await fetch(subtitleUrl, { credentials: "include" });
    if (!response.ok) {
      
      return makeDegraded("subtitle-fetch-failed");
    }
    const json = (await response.json()) as { body?: { from?: number; to?: number; content?: string }[] };
    body = Array.isArray(json.body) ? json.body : [];
  } catch {
    return makeDegraded("subtitle-fetch-failed");
  }
  const cues = body
    .filter((cue) => typeof cue?.content === "string" && cue.content.trim().length > 0)
    .slice(0, 2000)
    .map((cue) => ({
      startMs: Math.max(0, Math.round((cue.from ?? 0) * 1000)),
      endMs: Math.max(0, Math.round((cue.to ?? 0) * 1000)),
      text: (cue.content ?? "").trim(),
    }));
  if (cues.length === 0) {
    return makeDegraded("no-subtitle");
  }
  return { ok: true, url, title, author, cues };
}

export function isBilibiliVideoUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /(^|\.)bilibili\.com$/.test(parsed.hostname) && /^\/video\//.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function bilibiliBvId(url: string): string | null {
  const match = /\/video\/(BV[0-9A-Za-z]+)/.exec(url);
  return match ? match[1] : null;
}


export function isXiaohongshuUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /(^|\.)xiaohongshu\.com$/i.test(parsed.hostname) || /(^|\.)xhs\.cn$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}


export function isBilibiliListUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "space.bilibili.com" && /^\/\d+\/favlist/.test(parsed.pathname)) return true;
    return /(^|\.)bilibili\.com$/.test(parsed.hostname) && parsed.pathname.startsWith("/watchlater");
  } catch {
    return false;
  }
}


export const LIST_CHILD_ORIGIN = "https://www.bilibili.com/";


export function extractBilibiliVideoLinks(): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const anchor of Array.from(document.querySelectorAll('a[href*="/video/BV"]'))) {
    const href = anchor.getAttribute("href") ?? "";
    const match = /\/video\/(BV[0-9A-Za-z]+)/.exec(href);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    urls.push(`https://www.bilibili.com/video/${match[1]}`);
    if (urls.length >= 50) break;
  }
  return urls;
}



function sanitizeIdPart(value: string, maxLength: number): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned.slice(0, maxLength) || "unknown";
}

export function deriveSourceId(url: string, platform: string, contentHash?: string): string {
  if (platform === "bilibili") {
    const bv = bilibiliBvId(url);
    if (bv) return `bilibili:${bv}`;
  }
  if (platform === "xiaohongshu") {
    try {
      const parsed = new URL(url);
      const match = /^\/(?:explore|discovery\/item)\/([^/?#]+)/.exec(parsed.pathname);
      if (match) return `xiaohongshu:${sanitizeIdPart(match[1], 96)}`;
    } catch {
    }
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const slug = sanitizeIdPart(parsed.pathname.replace(/\/+$/, "").split("/").pop() ?? "page", 48);
    const base = `web:${sanitizeIdPart(host, 48)}:${slug}`;
    return contentHash ? `${base}:${contentHash.slice(0, 8)}` : base;
  } catch {
    return `web:unknown:${sanitizeIdPart(url, 48)}`;
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface BuildInput {
  originalUrl: string;
  finalUrl: string;
  title: string;
  platform: string;
  contentType: ParserContentType;
  blocks: { kind: ParserBlockKind; text: string; locator: ParserLocator }[];
  jobId: string;
  author?: string | null;
  publishedAt?: string | null;
  warnings?: ParserProblem[];
}

export async function buildParserOutput(input: BuildInput): Promise<ParserOutput> {
  const now = new Date().toISOString();
  const hash = await sha256Hex(input.blocks.map((block) => block.text).join("\n"));
  return {
    schema_version: "0.1.0",
    source: {
      source_id: deriveSourceId(input.finalUrl || input.originalUrl, input.platform),
      original_url: input.originalUrl,
      canonical_url: input.finalUrl !== input.originalUrl ? input.finalUrl : null,
      platform: input.platform,
      content_type: input.contentType,
      title: input.title || null,
      author: input.author ?? null,
      published_at: input.publishedAt ?? null,
      fetched_at: now,
      language: "zh-CN",
      raw_content_ref: null,
    },
    blocks: input.blocks.map((block, index) => ({
      block_id: `block:${block.kind}:${String(index + 1).padStart(3, "0")}`,
      order: index,
      kind: block.kind,
      text: block.text,
      parent_block_id: null,
      locator: block.locator,
      asset_ids: [],
      metadata: {},
    })),
    assets: [],
    parse: {
      job_id: input.jobId,
      parser_name: "extension-snapshot",
      parser_version: "0.1.0",
      status: (input.warnings?.length ?? 0) > 0 ? "partial" : "completed",
      parsed_at: now,
      content_hash: `sha256:${hash}`,
      warnings: input.warnings ?? [],
      errors: [],
    },
  };
}

export function parserOutputToSource(output: ParserOutput): LibrarySource {
  const blocks: SourceBlock[] = output.blocks.map((block) => ({
    blockId: block.block_id,
    kind: block.kind,
    text: block.text,
    locator: {
      kind: block.locator.kind,
      ...(block.locator.start_ms != null ? { startMs: block.locator.start_ms } : {}),
      ...(block.locator.end_ms != null ? { endMs: block.locator.end_ms } : {}),
      ...(block.locator.page_number != null ? { pageNumber: block.locator.page_number } : {}),
      ...(block.locator.paragraph_index != null ? { paragraphIndex: block.locator.paragraph_index } : {}),
      ...(block.locator.selector != null ? { selector: block.locator.selector } : {}),
    },
  }));
  return {
    source_id: output.source.source_id,
    originalUrl: output.source.original_url,
    metadata: {
      title: output.source.title ?? undefined,
      ...(output.source.author ? { author: output.source.author } : {}),
    },
    blocks,
  };
}

import {
  extractArticleSnapshot,
  extractBilibiliSnapshot,
  extractBilibiliVideoLinks,
  extractXiaohongshuSnapshot,
  isBilibiliListUrl,
  isBilibiliVideoUrl,
  isXiaohongshuUrl,
  type ParserBlockKind,
  type ParserContentType,
  type ParserLocator,
  type ParserProblem,
} from "./parser";

export class SnapshotError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recoverable = true,
  ) {
    super(message);
    this.name = "SnapshotError";
  }
}

export interface SnapshotData {
  finalUrl: string;
  title: string;
  platform: string;
  contentType: ParserContentType;
  blocks: { kind: ParserBlockKind; text: string; locator: ParserLocator }[];
  author?: string | null;
  publishedAt?: string | null;
  listLinks: string[] | null;
  degradedNote?: string;
  warnings: ParserProblem[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const pageApis = {
  article: extractArticleSnapshot,
  bilibili: extractBilibiliSnapshot,
  xiaohongshu: extractXiaohongshuSnapshot,
  links: extractBilibiliVideoLinks,
};



export async function executeSnapshotOnTab(tabId: number, originalUrl: string): Promise<SnapshotData> {
  if (isBilibiliVideoUrl(originalUrl)) {
    
    const deadline = Date.now() + 6_000;
    let last: { code: string; message: string } | null = null;
    while (Date.now() < deadline) {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: pageApis.bilibili,
      });
      if (result?.ok) {
        if (result.degraded) {
          
          const degradedNote =
            result.degraded === "subtitle-fetch-failed"
              ? "字幕文件下载失败：仅收录标题与简介，重试可重新获取字幕；完整字幕转写需要 helper"
              : "该视频无字幕（含 AI 字幕）：仅收录标题与简介，完整字幕转写需要 helper";
          const descriptionLines = (result.description ?? "")
            .split(/\n+/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .slice(0, 40);
          return {
            finalUrl: result.url,
            title: result.title,
            platform: "bilibili",
            contentType: "video",
            author: result.author,
            blocks: [
              { kind: "heading" as const, text: result.title, locator: { kind: "paragraph" as const, paragraph_index: 0 } },
              ...descriptionLines.map((text, index) => ({
                kind: "paragraph" as const,
                text,
                locator: { kind: "paragraph" as const, paragraph_index: index + 1 },
              })),
            ],
            listLinks: null,
            degradedNote,
            warnings: [
              {
                code: result.degraded === "subtitle-fetch-failed" ? "SUBTITLE_FETCH_FAILED" : "NO_SUBTITLE_FALLBACK",
                message: degradedNote,
                stage: "extract",
                recoverable: result.degraded === "subtitle-fetch-failed",
              },
            ],
          };
        }
        return {
          finalUrl: result.url,
          title: result.title,
          platform: "bilibili",
          contentType: "video",
          author: result.author,
          blocks: result.cues.map((cue) => ({
            kind: "transcript" as const,
            text: cue.text,
            locator: { kind: "timestamp" as const, start_ms: cue.startMs, end_ms: cue.endMs },
          })),
          listLinks: null,
          warnings: [],
        };
      }
      last = result ?? { code: "EXTRACT_NO_RESULT", message: "页面脚本未返回结果。" };
      if (last.code !== "EXTRACT_NO_RESULT") break; // 临时性/权限错误直接抛
      await sleep(1200);
    }
    throw new SnapshotError(last?.code ?? "BILIBILI_SNAPSHOT_FAILED", last?.message ?? "B 站快照失败。");
  }

  if (isXiaohongshuUrl(originalUrl)) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageApis.xiaohongshu,
    });
    if (!result) throw new SnapshotError("EXTRACT_NO_RESULT", "小红书页面提取脚本没有返回结果。");
    if (!result.ok) throw new SnapshotError(result.code, result.message);

    const degradedNote =
      result.mediaCount > 0
        ? "本轮只保存公开可见的标题、正文和作者；图片、视频下载与 OCR 尚未进入插件 local Parser"
        : undefined;
    return {
      finalUrl: result.canonicalUrl,
      title: result.title,
      platform: "xiaohongshu",
      contentType: result.contentType,
      author: result.author,
      publishedAt: result.publishedAt,
      blocks: result.blocks.map((block) => ({
        kind: block.kind,
        text: block.text,
        locator: { kind: "dom" as const, selector: block.selector },
      })),
      listLinks: null,
      ...(degradedNote ? { degradedNote } : {}),
      warnings: degradedNote
        ? [
            {
              code: "XHS_MEDIA_NOT_CAPTURED",
              message: degradedNote,
              stage: "extract",
              recoverable: false,
            },
          ]
        : [],
    };
  }

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: pageApis.article,
  });
  if (!result) throw new SnapshotError("EXTRACT_NO_RESULT", "正文提取脚本没有返回结果。");
  if (!result.ok) {
    throw new SnapshotError(result.code, result.message);
  }

  
  let listLinks: string[] | null = null;
  if (isBilibiliListUrl(result.url) || isBilibiliListUrl(originalUrl)) {
    const [linksResult] = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageApis.links,
    });
    const links = linksResult?.result ?? [];
    listLinks = links.length > 0 ? links : null;
  }

  return {
    finalUrl: result.url,
    title: result.title,
    platform: detectPlatform(result.url),
    contentType: "article",
    blocks: result.blocks.map((block, index) => ({
      kind: block.kind,
      text: block.text,
      locator: { kind: "paragraph" as const, paragraph_index: index },
    })),
    listLinks,
    warnings: [],
  };
}

function detectPlatform(url: string): string {
  try {
    const host = new URL(url).hostname;
    if (/(^|\.)bilibili\.com$/.test(host)) return "bilibili";
    if (/(^|\.)xiaohongshu\.com$/.test(host) || /(^|\.)xhs\.cn$/.test(host)) return "xiaohongshu";
    if (/(^|\.)zhihu\.com$/.test(host)) return "zhihu";
    if (/(^|\.)mp\.weixin\.qq\.com$/.test(host)) return "wechat";
    return host.replace(/^www\./, "");
  } catch {
    return "web";
  }
}

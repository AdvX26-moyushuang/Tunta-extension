import { ensureOffscreen } from "@/offscreen/host";
import {
  PARSE_RPC_TARGET,
  type ArticleParseRequest,
  type ArticleParseResponse,
} from "@/shared/parse-rpc";
import { extractBilibiliVideoLinks, isBilibiliListUrl, type ParserProblem } from "../parser";
import { SnapshotError, type AdapterContext, type SnapshotData, type SourceAdapter } from "./types";

// executeScript 返回值走消息通道，超大页面截断以免撑爆消息大小限制
const MAX_HTML_CHARS = 4 * 1024 * 1024;

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

/**
 * 通用正文提取，永远排在注册表最后作为兜底。
 * 计划 §Task4.1：页面注入只抓 outerHTML（闭包会丢失，注入函数必须零依赖），
 * Readability 解析集中在 offscreen 文档里跑。
 */
export const articleAdapter: SourceAdapter = {
  name: "article",
  match: () => true,
  async extract({ tabId, originalUrl }: AdapterContext): Promise<SnapshotData> {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        url: location.href,
        title: (document.title || "").trim(),
        html: document.documentElement.outerHTML,
      }),
    });
    if (!result?.html) throw new SnapshotError("EXTRACT_NO_RESULT", "页面快照脚本没有返回 HTML。");

    await ensureOffscreen();
    const request: ArticleParseRequest = {
      target: PARSE_RPC_TARGET,
      op: "article",
      html: result.html.slice(0, MAX_HTML_CHARS),
      url: result.url,
    };
    const response = (await chrome.runtime.sendMessage(request)) as ArticleParseResponse | undefined;
    if (!response) throw new SnapshotError("EXTRACT_NO_RESULT", "offscreen 正文解析无响应。");
    if (!response.ok) throw new SnapshotError("READABILITY_FAILED", response.error);
    const parsed = response.value;
    if (parsed.blocks.length === 0) {
      throw new SnapshotError("EXTRACT_EMPTY", "未能从页面提取到正文内容。");
    }

    const warnings: ParserProblem[] = [];
    if (parsed.parserName === "dom-fallback") {
      warnings.push({
        code: "READABILITY_FALLBACK",
        message: "Readability 未识别出正文，已退回整页扫描，内容可能包含噪音。",
        stage: "extract",
        recoverable: false,
      });
    }

    let listLinks: string[] | null = null;
    if (isBilibiliListUrl(result.url) || isBilibiliListUrl(originalUrl)) {
      const [linksResult] = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractBilibiliVideoLinks,
      });
      const links = linksResult?.result ?? [];
      listLinks = links.length > 0 ? links : null;
    }

    return {
      finalUrl: result.url,
      title: parsed.title || result.title || result.url,
      platform: detectPlatform(result.url),
      contentType: "article",
      blocks: parsed.blocks.map((block, index) => ({
        kind: block.kind,
        text: block.text,
        locator: { kind: "paragraph" as const, paragraph_index: index },
      })),
      author: parsed.author,
      publishedAt: parsed.publishedAt,
      listLinks,
      warnings,
    };
  },
};

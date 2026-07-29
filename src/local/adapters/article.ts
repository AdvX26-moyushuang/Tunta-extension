import { extractArticleSnapshot, extractBilibiliVideoLinks, isBilibiliListUrl } from "../parser";
import { SnapshotError, type AdapterContext, type SnapshotData, type SourceAdapter } from "./types";

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

/** 通用正文提取，永远排在注册表最后作为兜底。 */
export const articleAdapter: SourceAdapter = {
  name: "article",
  match: () => true,
  async extract({ tabId, originalUrl }: AdapterContext): Promise<SnapshotData> {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractArticleSnapshot,
    });
    if (!result) throw new SnapshotError("EXTRACT_NO_RESULT", "正文提取脚本没有返回结果。");
    if (!result.ok) {
      throw new SnapshotError(result.code, result.message);
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
  },
};

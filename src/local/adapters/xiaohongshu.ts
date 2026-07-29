import { extractXiaohongshuSnapshot, isXiaohongshuUrl } from "../parser";
import { SnapshotError, type AdapterContext, type SnapshotData, type SourceAdapter } from "./types";

export const xiaohongshuAdapter: SourceAdapter = {
  name: "xiaohongshu",
  match: (url) => isXiaohongshuUrl(url),
  async extract({ tabId }: AdapterContext): Promise<SnapshotData> {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractXiaohongshuSnapshot,
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
  },
};

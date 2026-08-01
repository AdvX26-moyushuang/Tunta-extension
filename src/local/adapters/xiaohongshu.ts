import {
  collectPageImages,
  extractXiaohongshuSnapshot,
  isXiaohongshuUrl,
  type PageImageCapture,
} from "../parser";
import { loadSettings } from "../settings";
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

    // 图片 OCR（计划 §Task4.3）：opt-in 开启后才在页面上下文收集图片，
    // 标注在入库前由 annotatePageImages 完成（见 src/local/ocr.ts）
    const settings = await loadSettings();
    let images: PageImageCapture[] | undefined;
    if (settings.ocr.enabled && result.mediaCount > 0) {
      const [{ result: collected }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: collectPageImages,
      });
      images = collected?.length ? collected : undefined;
    }

    const degradedNote =
      result.mediaCount > 0 && !images
        ? settings.ocr.enabled
          ? "图片未能读取（跨域限制），本轮只保存标题、正文和作者"
          : "图片未做 OCR：可在工作台设置页开启「图片 OCR」（图片会发送给你配置的 provider）"
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
      ...(images ? { images } : {}),
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

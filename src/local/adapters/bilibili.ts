import { extractBilibiliSnapshot, isBilibiliVideoUrl } from "../parser";
import { SnapshotError, type AdapterContext, type SnapshotData, type SourceAdapter } from "./types";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const bilibiliAdapter: SourceAdapter = {
  name: "bilibili",
  match: (url) => isBilibiliVideoUrl(url),
  async extract({ tabId }: AdapterContext): Promise<SnapshotData> {
    const deadline = Date.now() + 6_000;
    let last: { code: string; message: string } | null = null;
    while (Date.now() < deadline) {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: extractBilibiliSnapshot,
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
  },
};

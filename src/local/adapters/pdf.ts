import { ensureOffscreen } from "@/offscreen/host";
import { bytesToBase64 } from "@/shared/db-rpc";
import {
  PARSE_RPC_TARGET,
  type PdfParseRequest,
  type PdfParseResponse,
} from "@/shared/parse-rpc";
import type { ParserProblem } from "../parser";
import { SnapshotError, type AdapterContext, type SnapshotData, type SourceAdapter } from "./types";

// base64 膨胀 4/3，再留出消息通道余量（上限 64MB）
const MAX_PDF_BYTES = 20 * 1024 * 1024;

export function isPdfUrl(url: string): boolean {
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function fileNameFromUrl(url: string): string {
  try {
    const segment = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(segment) || url;
  } catch {
    return url;
  }
}

/**
 * PDF 提取（计划 §Task4.2）：Chrome 内置 PDF 查看器是插件，executeScript 拿不到内容，
 * 必须由扩展 fetch 原始字节再交给 offscreen 的 pdfjs。不依赖 tabId。
 * 本地 file:// 的 PDF 需要用户在扩展详情页手动开启「允许访问文件网址」。
 */
export const pdfAdapter: SourceAdapter = {
  name: "pdf",
  match: isPdfUrl,
  async extract({ originalUrl }: AdapterContext): Promise<SnapshotData> {
    let bytes: Uint8Array;
    try {
      const response = await fetch(originalUrl, { credentials: "omit" });
      if (!response.ok) {
        throw new SnapshotError("PDF_FETCH_FAILED", `PDF 下载失败：HTTP ${response.status}`);
      }
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (cause) {
      if (cause instanceof SnapshotError) throw cause;
      const hint = originalUrl.startsWith("file:")
        ? "本地 PDF 需要在扩展详情页开启「允许访问文件网址」后重试。"
        : "网络错误或没有该站点的访问权限。";
      throw new SnapshotError("PDF_FETCH_FAILED", `PDF 下载失败：${hint}`);
    }
    if (bytes.length > MAX_PDF_BYTES) {
      throw new SnapshotError("PDF_TOO_LARGE", "PDF 超过 20MB，超出本地解析上限。");
    }
    // %PDF 魔数校验：.pdf 结尾的 URL 可能实际返回 HTML（登录页/404 页）
    const magic = String.fromCharCode(...bytes.slice(0, 5));
    if (!magic.startsWith("%PDF")) {
      throw new SnapshotError("PDF_INVALID", "该 URL 返回的不是 PDF 文件（可能需要登录）。");
    }

    await ensureOffscreen();
    const request: PdfParseRequest = { target: PARSE_RPC_TARGET, op: "pdf", data: bytesToBase64(bytes) };
    const response = (await chrome.runtime.sendMessage(request)) as PdfParseResponse | undefined;
    if (!response) throw new SnapshotError("PDF_PARSE_FAILED", "offscreen PDF 解析无响应。");
    if (!response.ok) throw new SnapshotError("PDF_PARSE_FAILED", response.error);
    const parsed = response.value;
    if (parsed.blocks.length === 0) {
      throw new SnapshotError("PDF_EMPTY", "未能从 PDF 提取到文本（可能是扫描件，需等图片 OCR 支持）。");
    }

    const warnings: ParserProblem[] = [];
    if (parsed.truncated) {
      warnings.push({
        code: "PDF_TRUNCATED",
        message: `PDF 共 ${parsed.pageCount} 页，超出块数上限，只保留了前面部分。`,
        stage: "extract",
        recoverable: false,
      });
    }

    return {
      finalUrl: originalUrl,
      title: parsed.title || fileNameFromUrl(originalUrl),
      platform: "pdf",
      contentType: "article",
      blocks: parsed.blocks.map((block) => ({
        kind: "paragraph" as const,
        text: block.text,
        locator: { kind: "page" as const, page_number: block.pageNumber },
      })),
      listLinks: null,
      warnings,
    };
  },
};

// PDF 文本提取（计划 §Task4.2）：pdfjs-dist 只在 offscreen 文档里跑。
// MV3 坑：worker 必须打包后用 chrome.runtime.getURL 指定（不能走 CDN）。
// 计划提的 isEvalSupported: false 已不需要：pdfjs 6.x 彻底删了 eval 代码路径。
import { base64ToBytes } from "@/shared/db-rpc";
import type { PdfParseBlock, PdfParseResult } from "@/shared/parse-rpc";

const MAX_PDF_BLOCKS = 400;
/** 行累积到这个长度就切一个块，让超长页拆成多个可检索段落。 */
const BLOCK_TARGET_CHARS = 400;

// 动态 import：PDF 是低频路径，不拖慢 offscreen 启动（DB RPC 就绪优先）
async function loadPdfjs() {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(worker.default.replace(/^\//, ""));
  return pdfjs;
}

export async function parsePdf(base64Data: string): Promise<PdfParseResult> {
  const pdfjs = await loadPdfjs();
  const loadingTask = pdfjs.getDocument({
    data: base64ToBytes(base64Data),
    useSystemFonts: true,
  });
  const doc = await loadingTask.promise;

  let title: string | null = null;
  try {
    const meta = await doc.getMetadata();
    const info = meta.info as Record<string, unknown> | undefined;
    const rawTitle = typeof info?.Title === "string" ? info.Title.trim() : "";
    title = rawTitle || null;
  } catch {
    // 元数据损坏不致命，标题走 URL 兜底
  }

  const blocks: PdfParseBlock[] = [];
  let truncated = false;
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    if (blocks.length >= MAX_PDF_BLOCKS) {
      truncated = true;
      break;
    }
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    // getTextContent 的 items 带 hasEOL，按行拼接后攒到目标长度切块
    let line = "";
    let acc = "";
    const flushBlock = () => {
      const text = acc.replace(/\s+/g, " ").trim();
      if (text) blocks.push({ text: text.slice(0, 2000), pageNumber });
      acc = "";
    };
    for (const item of content.items) {
      if (!("str" in item)) continue;
      line += item.str;
      if (item.hasEOL) {
        acc += `${line.trim()}\n`;
        line = "";
        if (acc.length >= BLOCK_TARGET_CHARS) flushBlock();
      }
    }
    acc += line.trim();
    flushBlock();
    page.cleanup();
  }
  const pageCount = doc.numPages;
  await loadingTask.destroy();
  return { title, pageCount, blocks, truncated };
}

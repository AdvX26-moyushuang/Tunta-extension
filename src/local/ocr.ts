/**
 * 图片 OCR 富化（计划 §Task4.3）：把页面收集到的图片交给多模态 LLM，
 * 结果写进 ParserAsset.ocr_text / caption，并生成 kind:"ocr" 的 block
 * （通过 asset_ids 引用资产）让文字进入检索链路。
 *
 * LLM 调用是纯 fetch、无 DOM 依赖，与 callChatCompletion 同路径直接发起，
 * 不经过 offscreen——offscreen 只为 DOMParser / pdfjs 这类 DOM API 存在。
 * 失败降级为 warning，不阻断收藏本身。
 */
import type { PageImageCapture, ParserAsset, ParserBlockKind, ParserLocator, ParserProblem } from "./parser";
import { callImageAnnotation, type ImageForAnnotation } from "./provider";
import { isChatConfigured, loadSettings } from "./settings";

export interface OcrEnrichment {
  assets: ParserAsset[];
  blocks: { kind: ParserBlockKind; text: string; locator: ParserLocator; asset_ids: string[] }[];
  warnings: ParserProblem[];
}

const EMPTY: OcrEnrichment = { assets: [], blocks: [], warnings: [] };

export async function annotatePageImages(images: PageImageCapture[] | undefined): Promise<OcrEnrichment> {
  if (!images?.length) return EMPTY;
  const settings = await loadSettings();
  // 双保险：adapter 只在 OCR 开启时收集图片，这里再校验一次开关与配置
  if (!settings.ocr.enabled || !isChatConfigured(settings)) return EMPTY;

  const payload: ImageForAnnotation[] = [];
  const sources: PageImageCapture[] = [];
  for (const image of images) {
    const separator = image.dataUrl.indexOf(";base64,");
    if (!image.dataUrl.startsWith("data:image/") || separator < 0) continue;
    payload.push({
      mediaType: image.dataUrl.slice(5, separator),
      data: image.dataUrl.slice(separator + ";base64,".length),
    });
    sources.push(image);
  }
  if (payload.length === 0) return EMPTY;

  try {
    const annotations = await callImageAnnotation(settings.chat, payload);
    const assets: ParserAsset[] = [];
    const blocks: OcrEnrichment["blocks"] = [];
    annotations.forEach((annotation, index) => {
      const assetId = `asset:image:${String(index + 1).padStart(3, "0")}`;
      assets.push({
        asset_id: assetId,
        kind: "image",
        url: sources[index].url,
        blob_ref: null,
        ocr_text: annotation.ocrText || null,
        caption: annotation.caption || null,
        metadata: {},
      });
      const text = [annotation.caption, annotation.ocrText].filter(Boolean).join("\n");
      if (text) {
        blocks.push({ kind: "ocr", text, locator: { kind: "unknown" }, asset_ids: [assetId] });
      }
    });
    return { assets, blocks, warnings: [] };
  } catch (cause) {
    return {
      assets: [],
      blocks: [],
      warnings: [
        {
          code: "OCR_FAILED",
          message: `图片 OCR 失败（不影响正文收藏）：${cause instanceof Error ? cause.message : String(cause)}`,
          stage: "ocr",
          recoverable: true,
        },
      ],
    };
  }
}

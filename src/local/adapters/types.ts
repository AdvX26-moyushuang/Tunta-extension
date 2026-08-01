import type {
  PageImageCapture,
  ParserBlockKind,
  ParserContentType,
  ParserLocator,
  ParserProblem,
} from "../parser";

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
  /** OCR 待处理图片（已在页面上下文缩放转 base64）；仅 OCR 开启时携带。 */
  images?: PageImageCapture[];
  warnings: ParserProblem[];
}

export interface AdapterContext {
  tabId: number;
  originalUrl: string;
}

export interface SourceAdapter {
  name: string;
  match(url: string): boolean;
  extract(ctx: AdapterContext): Promise<SnapshotData>;
}

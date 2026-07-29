import type { ParserBlockKind, ParserContentType, ParserLocator, ParserProblem } from "../parser";

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

export interface AdapterContext {
  tabId: number;
  originalUrl: string;
}

export interface SourceAdapter {
  name: string;
  match(url: string): boolean;
  extract(ctx: AdapterContext): Promise<SnapshotData>;
}

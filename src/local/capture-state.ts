import type { CaptureParseWarning } from "@/shared/api/contracts";
import type { StoredCapture, StoredDocument } from "./store/types";

/**
 * Manual retry starts a new snapshot pipeline. The previous warning remains visible
 * until the new snapshot replaces Parser Output, so a lost message cannot look like success.
 */
export function resetCaptureForRetry(capture: StoredCapture, updatedAt: string): StoredCapture {
  const { stage: _stage, expandLinks: _expandLinks, ...rest } = capture;
  void _stage;
  void _expandLinks;
  return {
    ...rest,
    status: "idle",
    failure: null,
    curationNote: undefined,
    attempts: 0,
    updatedAt,
  };
}

/**
 * Parser Output owns parser diagnostics. Capture.parseWarnings is a denormalized
 * display copy, so the document repairs legacy / broken-retry rows where that copy is empty.
 */
export function resolveCaptureParseWarnings(
  capture: StoredCapture,
  document: StoredDocument | undefined,
): CaptureParseWarning[] | undefined {
  if (!document) return capture.parseWarnings;
  return document.parserOutput.parse.warnings.map(({ code, message, stage, recoverable }) => ({
    code,
    message,
    stage,
    recoverable,
  }));
}

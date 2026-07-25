import type { CaptureIntent } from "@/shared/api/contracts";
import { normalizeUrl } from "@/shared/format";
import { getCaptureByUrl, putCapture, type StoredCapture } from "./db";

export const LIST_EXPAND_LIMIT = 20;

export function newCaptureId(): string {
  return `cap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface ExpandResult {
  createdIds: string[];
  skipped: number;
}

export async function expandListCaptures(input: {
  links: string[];
  intent: CaptureIntent;
}): Promise<ExpandResult> {
  const createdIds: string[] = [];
  let skipped = 0;
  for (const rawLink of input.links.slice(0, LIST_EXPAND_LIMIT)) {
    const url = normalizeUrl(rawLink);
    if (!url || (await getCaptureByUrl(url))) {
      skipped += 1;
      continue;
    }
    const now = new Date().toISOString();
    const capture: StoredCapture = {
      captureId: newCaptureId(),
      url,
      title: "",
      intent: input.intent,
      status: "idle",
      sourceId: null,
      createdAt: now,
      updatedAt: now,
      archived: false,
      failure: null,
    };
    await putCapture(capture);
    createdIds.push(capture.captureId);
  }
  return { createdIds, skipped };
}

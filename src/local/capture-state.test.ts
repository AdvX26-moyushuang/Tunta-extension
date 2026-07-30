import assert from "node:assert/strict";
import test from "node:test";
import { resetCaptureForRetry, resolveCaptureParseWarnings } from "./capture-state.js";
import type { StoredCapture, StoredDocument } from "./store/types.js";

const warning = {
  code: "NO_SUBTITLE_FALLBACK",
  message: "该视频未提供字幕轨道：仅收录标题与简介",
  stage: "extract" as const,
  recoverable: false,
};

function makeCapture(): StoredCapture {
  return {
    captureId: "cap-retry",
    url: "https://www.bilibili.com/video/BV1RETRY",
    title: "旧标题",
    intent: "favorite",
    status: "done",
    stage: "graph",
    sourceId: "bilibili:BV1RETRY",
    curationNote: "AI 策展：只有简介",
    parseWarnings: [warning],
    expandLinks: ["https://www.bilibili.com/video/BV1STALE"],
    attempts: 2,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T01:00:00.000Z",
    archived: false,
    failure: null,
  };
}

function makeDocument(warnings: StoredDocument["parserOutput"]["parse"]["warnings"]): StoredDocument {
  return {
    sourceId: "bilibili:BV1RETRY",
    url: "https://www.bilibili.com/video/BV1RETRY",
    title: "旧标题",
    platform: "bilibili",
    contentHash: "hash",
    parserOutput: {
      schema_version: "0.1.0",
      source: {
        source_id: "bilibili:BV1RETRY",
        original_url: "https://www.bilibili.com/video/BV1RETRY",
        canonical_url: null,
        platform: "bilibili",
        content_type: "video",
        title: "旧标题",
        author: null,
        published_at: null,
        fetched_at: "2026-07-30T00:00:00.000Z",
        language: null,
        raw_content_ref: null,
      },
      blocks: [],
      assets: [],
      parse: {
        job_id: "job:cap-retry",
        parser_name: "tunta-local-parser",
        parser_version: "0.1.0",
        status: warnings.length > 0 ? "partial" : "completed",
        parsed_at: "2026-07-30T00:00:00.000Z",
        content_hash: "hash",
        warnings,
        errors: [],
      },
    },
    createdAt: "2026-07-30T00:00:00.000Z",
  };
}

test("retry resets the completed pipeline stage without erasing the last parser warning", () => {
  const reset = resetCaptureForRetry(makeCapture(), "2026-07-30T02:00:00.000Z");

  assert.equal(reset.status, "idle");
  assert.equal(reset.stage, undefined);
  assert.equal(reset.expandLinks, undefined);
  assert.equal(reset.curationNote, undefined);
  assert.equal(reset.attempts, 0);
  assert.equal(reset.updatedAt, "2026-07-30T02:00:00.000Z");
  assert.deepEqual(reset.parseWarnings, [warning]);
});

test("Parser Output restores warnings erased by the broken retry implementation", () => {
  const capture = { ...makeCapture(), parseWarnings: [] };

  assert.deepEqual(resolveCaptureParseWarnings(capture, makeDocument([warning])), [warning]);
  assert.deepEqual(resolveCaptureParseWarnings(capture, makeDocument([])), []);
});

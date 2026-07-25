import assert from "node:assert/strict";
import test from "node:test";
import type { CaptureItem } from "../shared/api/contracts.js";
import { chooseReviewCandidate, createSingleFlight } from "./review.js";

function capture(captureId: string): CaptureItem {
  return {
    captureId,
    url: `https://example.com/${captureId}`,
    title: captureId,
    intent: "pending",
    status: "done",
    sourceId: `source:${captureId}`,
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
    archived: false,
    failure: null,
  };
}

test("keeps the seen set intact when the review queue is exhausted", () => {
  const seen = new Set(["cap:last"]);
  const selection = chooseReviewCandidate(
    [{ capture: capture("cap:last"), cards: [{ cardId: "card:last" }] }],
    seen,
    () => 0,
  );

  assert.equal(selection.candidate, null);
  assert.equal(selection.remaining, 0);
  assert.deepEqual([...selection.seen], ["cap:last"]);
});

test("coalesces concurrent review loads into one stateful request", async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const load = createSingleFlight(async () => {
    calls += 1;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return calls;
  });

  const first = load();
  const second = load();
  assert.strictEqual(first, second);
  assert.equal(calls, 1);

  release?.();
  assert.equal(await first, 1);
  assert.equal(await second, 1);

  const third = load();
  assert.equal(calls, 2);
  release?.();
  assert.equal(await third, 2);
});

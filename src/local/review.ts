import type { CaptureItem } from "../shared/api/contracts";

export interface ReviewCandidate<TCard> {
  capture: CaptureItem;
  cards: TCard[];
}

export interface ReviewSelection<TCard> {
  candidate: ReviewCandidate<TCard> | null;
  remaining: number;
  seen: Set<string>;
}

export function chooseReviewCandidate<TCard>(
  candidates: ReviewCandidate<TCard>[],
  seen: ReadonlySet<string>,
  random: () => number = Math.random,
): ReviewSelection<TCard> {
  const pool = candidates.filter(
    ({ capture, cards }) =>
      capture.intent === "pending" &&
      !capture.archived &&
      capture.status === "done" &&
      !seen.has(capture.captureId) &&
      cards.length > 0,
  );
  const nextSeen = new Set(seen);
  if (pool.length === 0) {
    return { candidate: null, remaining: 0, seen: nextSeen };
  }

  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
  const candidate = pool[index];
  nextSeen.add(candidate.capture.captureId);
  return { candidate, remaining: pool.length - 1, seen: nextSeen };
}

export function createSingleFlight<T>(load: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight) return inFlight;
    const request = load();
    inFlight = request;
    const clear = () => {
      if (inFlight === request) inFlight = null;
    };
    void request.then(clear, clear);
    return request;
  };
}

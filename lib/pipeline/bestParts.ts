// =====================================================================
// lib/pipeline/bestParts.ts — CPU / offline "best parts" fallback (issue #62).
//
// When the visual verdict is unavailable (cloud AI disabled / WebGPU absent)
// or the matches are weak, the normal selection can collapse to a single
// 1-second peak. This module builds a BROADER, SPREAD reel from local
// evidence only — the candidate windows already computed from motion /
// saliency / (optional) semantic scores. It:
//
//   - expands short / single-frame windows to a useful minimum length,
//   - keeps clips inside the source bounds,
//   - avoids overlaps,
//   - spreads picks across the whole video (not one random cluster),
//   - tries to APPROACH a user-stated target duration,
//   - imposes NO fixed clip count (count emerges from target / source / spread).
//
// Pure + dependency-light (only config constants via a relative import) so it
// is unit-testable with `node --test --experimental-strip-types`.
// =====================================================================

import { OFFLINE_BEST_PARTS } from "../config";

export interface BestPartCandidate {
  start: number;
  end: number;
  /** Any 0..1 interest score (motion/saliency/composite). Higher = better. */
  score: number;
}

/**
 * Expand a (possibly 1-frame) range toward `minSeconds`, capped at
 * `maxSeconds`, clamped to [0, sourceDuration], and shrunk to avoid
 * overlapping any already-`occupied` clip. Returns the safe range; it may be
 * shorter than `minSeconds` if the surrounding gap is genuinely too small.
 */
export function expandClipRange(
  range: { start: number; end: number },
  opts: {
    sourceDuration: number;
    minSeconds: number;
    maxSeconds: number;
    occupied?: ReadonlyArray<{ start: number; end: number }>;
  }
): { start: number; end: number } {
  const { sourceDuration, minSeconds, maxSeconds, occupied = [] } = opts;
  const safeDur = Math.max(0, sourceDuration);
  const start = Math.max(0, Math.min(range.start, safeDur));
  const end = Math.max(start, Math.min(range.end, safeDur));

  // Bounds from the nearest occupied clips on either side — we may not cross
  // these (no overlap) and we never leave the video.
  let lowerBound = 0;
  let upperBound = safeDur;
  for (const o of occupied) {
    if (o.end <= start && o.end > lowerBound) lowerBound = o.end;
    if (o.start >= end && o.start < upperBound) upperBound = o.start;
  }

  const available = Math.max(0, upperBound - lowerBound);
  // Desired length: at least the current length, at least minSeconds, but no
  // more than maxSeconds and never more than the available gap.
  const targetLen = Math.min(Math.max(end - start, minSeconds), maxSeconds, available);

  const center = (start + end) / 2;
  let newStart = center - targetLen / 2;
  let newEnd = center + targetLen / 2;

  if (newStart < lowerBound) {
    newStart = lowerBound;
    newEnd = Math.min(upperBound, newStart + targetLen);
  }
  if (newEnd > upperBound) {
    newEnd = upperBound;
    newStart = Math.max(lowerBound, newEnd - targetLen);
  }
  return { start: round2(newStart), end: round2(newEnd) };
}

/**
 * Build a spread, expanded, non-overlapping set of clips from candidate
 * windows, approaching `targetSeconds` of total duration.
 *
 * Strategy (no fixed clip count):
 *   1. Bucket the source into ~target/preferredClip time buckets and take the
 *      best-scoring candidate per bucket → guaranteed spread across the video.
 *   2. Top up from the remaining candidates (best score first) until close to
 *      the target or candidates run out.
 *   3. Every pick is expanded to a useful length and trimmed to avoid overlap.
 */
export function buildOfflineBestParts(args: {
  candidates: ReadonlyArray<BestPartCandidate>;
  sourceDuration: number;
  targetSeconds: number;
  /** Minimum useful clip length (TARGET_COVERAGE.minUsefulClipSeconds). */
  minUsefulSeconds: number;
  /** Upper bound per clip (plan.maxClipSeconds). */
  maxClipSeconds: number;
  /** Hard cap on clip count (OFFLINE_BEST_PARTS.maxClips). */
  maxClips: number;
}): BestPartCandidate[] {
  const {
    candidates,
    sourceDuration,
    targetSeconds,
    minUsefulSeconds,
    maxClipSeconds,
    maxClips
  } = args;

  if (candidates.length === 0 || sourceDuration <= 0 || targetSeconds <= 0) {
    return [];
  }

  const fillTarget = targetSeconds * OFFLINE_BEST_PARTS.fillToFraction;
  const preferred = Math.min(maxClipSeconds, OFFLINE_BEST_PARTS.preferredClipSeconds);
  const approxClips = Math.max(
    1,
    Math.min(maxClips, Math.round(fillTarget / Math.max(preferred, 1)))
  );
  const bucketSize = sourceDuration / approxClips;

  // Best candidate per spread bucket (keyed by mid-point bucket index).
  const bestPerBucket = new Map<number, BestPartCandidate>();
  for (const c of candidates) {
    const mid = (c.start + c.end) / 2;
    const b = Math.min(approxClips - 1, Math.floor(mid / Math.max(bucketSize, 0.001)));
    const cur = bestPerBucket.get(b);
    if (!cur || c.score > cur.score) bestPerBucket.set(b, c);
  }

  // Primary picks (one per bucket, ordered along the timeline) then a
  // secondary score-ranked pool of everything else to top up the target.
  const primary = [...bestPerBucket.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, c]) => c);
  const used = new Set<BestPartCandidate>(primary);
  const secondary = candidates
    .filter((c) => !used.has(c))
    .slice()
    .sort((a, b) => b.score - a.score);

  const chosen: BestPartCandidate[] = [];
  let total = 0;
  // A pick is rejected if its post-overlap-trim length is below this floor —
  // better to skip a sliver than ship a flash. Half the useful minimum keeps
  // genuinely tight gaps usable while discarding degenerate ones.
  const keepFloor = minUsefulSeconds * 0.5;

  const consider = (c: BestPartCandidate) => {
    if (chosen.length >= maxClips || total >= fillTarget) return;
    const e = expandClipRange(
      { start: c.start, end: c.end },
      {
        sourceDuration,
        minSeconds: minUsefulSeconds,
        maxSeconds: maxClipSeconds,
        occupied: chosen
      }
    );
    const dur = e.end - e.start;
    if (dur < keepFloor) return;
    if (overlapsAny(e, chosen)) return;
    chosen.push({ start: e.start, end: e.end, score: c.score });
    total += dur;
  };

  for (const c of primary) consider(c);
  for (const c of secondary) consider(c);

  chosen.sort((a, b) => a.start - b.start);
  return chosen;
}

function overlapsAny(
  a: { start: number; end: number },
  others: ReadonlyArray<{ start: number; end: number }>
): boolean {
  for (const o of others) {
    if (a.start < o.end && a.end > o.start) return true;
  }
  return false;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

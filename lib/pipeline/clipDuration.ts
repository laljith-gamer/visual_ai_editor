// =====================================================================
// lib/pipeline/clipDuration.ts
//
// DYNAMIC clip-duration bounds. Replaces the effectively-fixed ~3s clip
// length (the old offline fallback expanded every short peak to a flat
// TARGET_COVERAGE.minUsefulClipSeconds = 3) with bounds derived from the
// SOURCE VIDEO length (and the user's target when stated):
//
//   - min as short as ~1s (a quick beat) on short videos,
//   - max scaling with the video (a few seconds on a 30s clip, up to tens of
//     seconds on a long video),
//   - a per-clip length that VARIES with interest score (stronger peak →
//     longer clip) so a reel isn't a row of identical blocks.
//
// GUARDRAILS only — no fixed clip count, no forced duration. Explicit
// user/plan bounds always win when provided. PURE + unit-tested.
// =====================================================================

import { CLIP_DURATION } from "../config";

export interface ClipDurationBounds {
  /** Shortest a clip may be (seconds). */
  minClipSeconds: number;
  /** Longest a clip may be (seconds). */
  maxClipSeconds: number;
  /** Typical clip length used when expanding a short peak (seconds). */
  preferredClipSeconds: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Derive dynamic clip-duration bounds from the source duration + optional
 * target. Explicit `userMinClipSeconds` / `userMaxClipSeconds` (when the user
 * or plan named a clip length) take priority but are still clamped to the
 * absolute floor/ceiling.
 */
export function deriveClipDurationBounds(opts: {
  videoDuration: number;
  targetSeconds?: number | null;
  userMinClipSeconds?: number;
  userMaxClipSeconds?: number;
}): ClipDurationBounds {
  const C = CLIP_DURATION;
  const dur = Math.max(0, opts.videoDuration || 0);

  // ---- min ----
  let minClip =
    typeof opts.userMinClipSeconds === "number" && opts.userMinClipSeconds > 0
      ? opts.userMinClipSeconds
      : clamp(dur * C.minFractionOfVideo, C.absoluteMinSeconds, C.minCeilingSeconds);
  minClip = clamp(minClip, C.absoluteMinSeconds, C.absoluteMaxSeconds);

  // ---- max ----
  let maxClip =
    typeof opts.userMaxClipSeconds === "number" && opts.userMaxClipSeconds > 0
      ? opts.userMaxClipSeconds
      : clamp(dur * C.maxFractionOfVideo, C.maxFloorSeconds, C.absoluteMaxSeconds);
  // Never let max collapse below min; never exceed the video itself.
  maxClip = clamp(maxClip, minClip, C.absoluteMaxSeconds);
  if (dur > 0) maxClip = Math.min(maxClip, Math.max(minClip, dur));

  // ---- preferred ----
  let preferred: number;
  if (typeof opts.targetSeconds === "number" && opts.targetSeconds > 0) {
    // Aim for a handful of watchable clips, not many slivers.
    preferred = opts.targetSeconds / C.preferredClipsForTarget;
  } else {
    preferred = minClip + (maxClip - minClip) * C.preferredBetween;
  }
  preferred = clamp(preferred, minClip, maxClip);

  return {
    minClipSeconds: round2(minClip),
    maxClipSeconds: round2(maxClip),
    preferredClipSeconds: round2(preferred)
  };
}

/**
 * Score-scaled target length for a single clip: a low-interest peak gets a
 * short clip (near min), a strong peak gets a longer clip (toward max),
 * anchored around `preferred`. `score` is any 0..1 interest value.
 */
export function clipLengthForScore(
  score: number,
  bounds: ClipDurationBounds
): number {
  const s = clamp(score, 0, 1);
  const { minClipSeconds: min, maxClipSeconds: max, preferredClipSeconds: pref } = bounds;
  // Below-average interest interpolates min→preferred; above-average
  // interpolates preferred→max. This keeps most clips near `preferred` while
  // letting standout moments breathe.
  const mid = 0.5;
  const len =
    s <= mid
      ? min + (pref - min) * (s / mid)
      : pref + (max - pref) * ((s - mid) / (1 - mid));
  return round2(clamp(len, min, max));
}

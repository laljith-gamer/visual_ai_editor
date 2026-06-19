// =====================================================================
// lib/analysis/budget.ts
//
// Dynamic, LOCAL-ONLY analysis budget planner. Replaces the single fixed
// ~240-frame cap with a per-request budget: a human editor scans a
// different amount for "describe this" vs "best parts of a 30-min video"
// vs "add the first 30 seconds" (no scan at all).
//
// PURE: the only import is the centralized config (no magic numbers here).
// No browser APIs, no scoring, no side effects — fully unit-testable.
// =====================================================================

import { ANALYSIS, DEVICE_TIER } from "../config";
import type { AnalysisBudget, AnalysisBudgetInput, AnalysisPurpose } from "./types";

type Band = {
  minFrames: number;
  maxFrames: number;
  inferenceWidth: number;
  baseEverySeconds: number;
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Pick the scan band for a best-parts/highlights purpose by duration. */
function bandForHighlights(durationSeconds: number): Band {
  if (durationSeconds > 0 && durationSeconds <= ANALYSIS.thresholds.shortVideoSeconds) {
    return ANALYSIS.quickScan;
  }
  if (durationSeconds >= ANALYSIS.thresholds.longVideoSeconds) {
    return ANALYSIS.longVideoScan;
  }
  return ANALYSIS.normalScan;
}

function tierFactor(tier: AnalysisBudgetInput["deviceTier"]): number {
  return DEVICE_TIER.frameFactor[tier] ?? DEVICE_TIER.frameFactor.unknown;
}

/**
 * Choose how many frames to sample within a band given the video duration and
 * device tier. Short videos sample FEWER frames naturally; long videos are
 * capped at the band max (shifted by the device tier). The device tier only
 * moves the ceiling inside the band — it never invents frames beyond max.
 */
function frameCountFor(band: Band, durationSeconds: number, tier: AnalysisBudgetInput["deviceTier"]): number {
  const tierCeil = clamp(Math.round(band.maxFrames * tierFactor(tier)), band.minFrames, band.maxFrames);
  if (durationSeconds <= 0) return tierCeil;
  const natural = Math.ceil(durationSeconds / band.baseEverySeconds);
  // For short clips, fewer frames than the band min is fine — don't
  // over-sample a 5s video just because a band's floor is 24.
  const lowFloor = Math.min(band.minFrames, natural);
  return clamp(natural, lowFloor, tierCeil);
}

function everyFor(durationSeconds: number, frames: number, denseFloor: number): number {
  if (durationSeconds <= 0 || frames <= 0) return denseFloor;
  return round2(Math.max(denseFloor, durationSeconds / frames));
}

const ZERO_FRAME_PURPOSES: ReadonlySet<AnalysisPurpose> = new Set<AnalysisPurpose>([
  "none",
  "metadata",
  "transcript_search"
]);

/**
 * Plan the analysis budget for one source given the request purpose, video
 * duration, device tier, and cache state. Returns an upper-bound budget; the
 * actual scan samples fewer frames for short videos.
 */
export function planAnalysisBudget(input: AnalysisBudgetInput): AnalysisBudget {
  const { purpose, durationSeconds, deviceTier, hasCachedQuickScan, hasCachedDeepScan } = input;

  // ---- Zero-analysis purposes: exact edits, control, transcript-only ----
  if (ZERO_FRAME_PURPOSES.has(purpose)) {
    return {
      purpose,
      maxFrames: 0,
      sampleEverySeconds: 0,
      inferenceWidth: 0,
      allowSemanticPass: false,
      allowDenseWindowPass: false,
      denseFramesPerWindow: 0,
      maxCandidateWindows: 0,
      reason:
        purpose === "transcript_search"
          ? "Transcript/caption search — no frame analysis needed."
          : "Exact / control request — no AI frame analysis needed."
    };
  }

  // ---- Quick describe: a few evenly spread keyframes, no semantic pass ----
  if (purpose === "quick_describe") {
    if (hasCachedQuickScan || hasCachedDeepScan) {
      return {
        purpose,
        maxFrames: 0,
        sampleEverySeconds: 0,
        inferenceWidth: ANALYSIS.quickDescribe.inferenceWidth,
        allowSemanticPass: false,
        allowDenseWindowPass: false,
        denseFramesPerWindow: 0,
        maxCandidateWindows: 0,
        reason: "Reusing the cached scan to describe this video — no new sampling."
      };
    }
    const band = ANALYSIS.quickDescribe;
    const frames = frameCountFor(band, durationSeconds, deviceTier);
    return {
      purpose,
      maxFrames: frames,
      sampleEverySeconds: everyFor(durationSeconds, frames, band.baseEverySeconds),
      inferenceWidth: band.inferenceWidth,
      allowSemanticPass: false,
      allowDenseWindowPass: false,
      denseFramesPerWindow: 0,
      maxCandidateWindows: 0,
      reason: `Quick look at ${frames} keyframe${frames === 1 ? "" : "s"} — enough for a rough description.`
    };
  }

  // ---- Specific visual search: coarse first, deep only on candidates ----
  if (purpose === "specific_visual_search") {
    const coarse = bandForHighlights(durationSeconds);
    const coarseFrames = hasCachedDeepScan ? 0 : frameCountFor(coarse, durationSeconds, deviceTier);
    return {
      purpose,
      maxFrames: coarseFrames,
      sampleEverySeconds: everyFor(durationSeconds, coarseFrames || 1, coarse.baseEverySeconds),
      inferenceWidth: ANALYSIS.deepScan.inferenceWidth,
      allowSemanticPass: true,
      allowDenseWindowPass: true,
      denseFramesPerWindow: ANALYSIS.denseWindow.framesPerWindow,
      maxCandidateWindows: ANALYSIS.denseWindow.maxCandidateWindows,
      reason: hasCachedDeepScan
        ? "Reusing cached frame scores; running the semantic search on candidate windows only."
        : "Coarse scan first, then a deep semantic pass on the strongest candidate windows only."
    };
  }

  // ---- Deep story (multi-video cinematic): coarse per source + semantic ----
  if (purpose === "deep_story") {
    const band = bandForHighlights(durationSeconds);
    const frames = hasCachedDeepScan ? 0 : frameCountFor(band, durationSeconds, deviceTier);
    return {
      purpose,
      maxFrames: frames,
      sampleEverySeconds: everyFor(durationSeconds, frames || 1, band.baseEverySeconds),
      inferenceWidth: band.inferenceWidth,
      allowSemanticPass: true,
      allowDenseWindowPass: true,
      denseFramesPerWindow: ANALYSIS.denseWindow.framesPerWindow,
      maxCandidateWindows: ANALYSIS.denseWindow.maxCandidateWindows,
      reason: "Coarse scan of each source to summarize roles, then deeper analysis where it matters."
    };
  }

  // ---- Best parts / highlights (quick_best_parts | normal_highlights) ----
  const band = bandForHighlights(durationSeconds);
  if (hasCachedDeepScan || (hasCachedQuickScan && band === ANALYSIS.quickScan)) {
    return {
      purpose,
      maxFrames: 0,
      sampleEverySeconds: 0,
      inferenceWidth: band.inferenceWidth,
      allowSemanticPass: true,
      allowDenseWindowPass: true,
      denseFramesPerWindow: ANALYSIS.denseWindow.framesPerWindow,
      maxCandidateWindows: ANALYSIS.denseWindow.maxCandidateWindows,
      reason: "Reusing the cached scan — selecting clips without re-sampling frames."
    };
  }
  const frames = frameCountFor(band, durationSeconds, deviceTier);
  const isLong = durationSeconds >= ANALYSIS.thresholds.longVideoSeconds;
  return {
    purpose,
    maxFrames: frames,
    sampleEverySeconds: everyFor(durationSeconds, frames, band.baseEverySeconds),
    inferenceWidth: band.inferenceWidth,
    allowSemanticPass: true,
    allowDenseWindowPass: isLong,
    denseFramesPerWindow: ANALYSIS.denseWindow.framesPerWindow,
    maxCandidateWindows: ANALYSIS.denseWindow.maxCandidateWindows,
    reason: isLong
      ? `Long video — coarse scan of ${frames} frames, then deep analysis only on the best windows.`
      : `Scanning ${frames} frames to find the best parts.`
  };
}

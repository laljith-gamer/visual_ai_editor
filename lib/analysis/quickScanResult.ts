// =====================================================================
// lib/analysis/quickScanResult.ts
//
// PURE reducer: turn the per-keyframe motion + saliency signals from a
// bounded local scan into a compact VideoAnalysisMemory patch (level 1)
// PLUS the clarification signals the editor needs (confidence, candidate
// strength, the distinct structural content types found).
//
// This is STRUCTURAL only — motion/saliency are model-free signals from the
// canvas pass (lib/pipeline/sample.ts). It NEVER fabricates captions or
// claims to name on-screen subjects. PURE: imports config + types only.
// Unit-tested. The browser runner (lib/analysis/quickScan.ts) samples the
// frames and calls this; it never persists raw frames.
// =====================================================================

import { QUICK_SCAN } from "../config";
import type { KeyframeMemory, TimeRangeScore, VideoAnalysisMemoryPatch } from "./types";

/** One sampled keyframe's model-free signals. */
export interface QuickScanFrame {
  t: number;
  motion: number;
  saliency: number;
}

export interface QuickScanSummary {
  patch: VideoAnalysisMemoryPatch;
  /** 0..1 overall confidence in the structural read. */
  confidence: number;
  /** Strength (0..1) of the best candidate window. */
  candidateStrength: number;
  /** Distinct structural content types found (e.g. ["motion","static"]). */
  contentTypes: string[];
  /** Whether the scan is low-confidence (caller may offer a deeper scan). */
  lowConfidence: boolean;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function combinedInterest(motion: number, saliency: number): number {
  return clamp01(QUICK_SCAN.motionWeight * motion + QUICK_SCAN.saliencyWeight * saliency);
}

/**
 * Reduce the sampled keyframes to a compact structural memory patch (level
 * 1) and the clarification signals. The window length is derived from the
 * sampling step so each peak frame becomes a small, non-zero range.
 */
export function summarizeQuickScan(
  frames: QuickScanFrame[],
  durationSeconds: number
): QuickScanSummary {
  const sorted = [...frames].filter((f) => Number.isFinite(f.t)).sort((a, b) => a.t - b.t);

  // Window length: the median gap between samples, clamped to something
  // sensible so a single frame seeds a real (not zero-length) range.
  const step =
    sorted.length >= 2
      ? Math.max(0.5, (sorted[sorted.length - 1].t - sorted[0].t) / Math.max(1, sorted.length - 1))
      : Math.max(0.5, Math.min(2, durationSeconds || 1));

  const cap = durationSeconds > 0 ? durationSeconds : Infinity;
  const rangeFor = (t: number): { start: number; end: number } => ({
    start: round2(Math.max(0, t)),
    end: round2(Math.min(cap, t + step))
  });

  const motionPeaks: TimeRangeScore[] = [];
  const saliencyPeaks: TimeRangeScore[] = [];
  const staticRanges: TimeRangeScore[] = [];
  const goodCandidates: TimeRangeScore[] = [];
  const weakCandidates: TimeRangeScore[] = [];

  let best = 0;
  for (const f of sorted) {
    const motion = clamp01(f.motion);
    const saliency = clamp01(f.saliency);
    const interest = combinedInterest(motion, saliency);
    best = Math.max(best, interest);
    const r = rangeFor(f.t);

    if (motion >= QUICK_SCAN.motionPeakFloor) {
      motionPeaks.push({ ...r, score: round2(motion), label: "high motion" });
    }
    if (saliency >= QUICK_SCAN.saliencyPeakFloor) {
      saliencyPeaks.push({ ...r, score: round2(saliency), label: "varied frame" });
    }
    if (motion <= QUICK_SCAN.staticMotionCeiling && saliency < QUICK_SCAN.saliencyPeakFloor) {
      staticRanges.push({ ...r, score: round2(1 - interest), label: "static" });
    }
    if (interest >= QUICK_SCAN.goodWindowFloor) {
      goodCandidates.push({ ...r, score: round2(interest), label: "interesting" });
    } else if (interest > 0) {
      weakCandidates.push({ ...r, score: round2(interest), label: "low interest" });
    }
  }

  // Keep the strongest windows, capped, sorted by time for stable storage.
  const topGood = [...goodCandidates]
    .sort((a, b) => b.score - a.score)
    .slice(0, QUICK_SCAN.maxWindows)
    .sort((a, b) => a.start - b.start);
  const topWeak = [...weakCandidates]
    .sort((a, b) => b.score - a.score)
    .slice(0, QUICK_SCAN.maxWindows)
    .sort((a, b) => a.start - b.start);

  // Compact keyframe memory (NO image — t + signals only), evenly thinned to
  // the cap so a long scan doesn't bloat storage.
  const keyframes: KeyframeMemory[] = thin(sorted, QUICK_SCAN.maxKeyframes).map((f) => ({
    t: round2(f.t),
    motion: round2(clamp01(f.motion)),
    saliency: round2(clamp01(f.saliency))
  }));

  // Distinct structural content types (NOT genre): does the video have real
  // motion, and does it have clearly static stretches?
  const contentTypes: string[] = [];
  if (motionPeaks.length > 0) contentTypes.push("motion");
  if (staticRanges.length >= 2) contentTypes.push("static");

  const candidateStrength = round2(topGood.length > 0 ? topGood[0].score : best);
  // Confidence: the best interest score, lifted when there are several strong
  // windows (a consistent signal), softened when nothing stood out.
  const consistency = Math.min(1, topGood.length / 3);
  const confidence = round2(clamp01(best * (0.7 + 0.3 * consistency)));
  const lowConfidence = best < QUICK_SCAN.lowConfidenceCeiling || topGood.length === 0;

  const summaryBits: string[] = [];
  if (motionPeaks.length > 0) summaryBits.push(`${motionPeaks.length} active moment(s)`);
  if (staticRanges.length > 0) summaryBits.push(`${staticRanges.length} static stretch(es)`);
  if (topGood.length > 0) summaryBits.push(`${topGood.length} candidate window(s)`);
  const summary =
    summaryBits.length > 0
      ? `Structural scan: ${summaryBits.join(", ")}.`
      : "Structural scan found little variation — the footage looks mostly flat.";

  const patch: VideoAnalysisMemoryPatch = {
    level: 1,
    confidence,
    summary,
    keyframes,
    motionPeaks,
    saliencyPeaks,
    staticRanges,
    knownGoodWindows: topGood,
    weakWindows: topWeak,
    durationSeconds: durationSeconds > 0 ? durationSeconds : undefined
  };

  return { patch, confidence, candidateStrength, contentTypes, lowConfidence };
}

/** Evenly thin an array down to at most `max` items, preserving order. */
function thin<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const out: T[] = [];
  const stepF = arr.length / max;
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * stepF)]);
  return out;
}

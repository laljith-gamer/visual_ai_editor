// =====================================================================
// lib/pipeline/scoreFallback.ts
//
// Pure signal math shared by the frame scorer + its degrade ladder. Kept in
// its own module (no worker / no browser imports) so it is unit-testable.
//
// The scorer degrades cloud → on-device → motion. This module owns:
//   - composite()          : the semantic+motion+saliency fusion.
//   - motionOnlyScores()   : the final fallback (semantic = 0) used for
//                            visual-interest plans AND when no semantic
//                            backend (WebGPU nor CPU/wasm) could load.
//   - isCloudResultUsable(): whether the cloud frame pass actually returned
//                            per-label scores (an all-empty result means the
//                            cloud route was unconfigured/blocked, so the
//                            caller should fall back to on-device scoring).
// =====================================================================

import type { FrameScore, SignalWeights } from "@/lib/types";
import type { SampledFrame } from "@/lib/pipeline/sample";

/** Fuse the three signals into one 0..1 composite score. */
export function composite(
  semantic: number,
  motion: number,
  saliency: number,
  w: SignalWeights
): number {
  const score = w.semantic * semantic + w.motion * motion + w.saliency * saliency;
  return Math.max(0, Math.min(1, score));
}

/** Motion + saliency only (semantic = 0). */
export function motionOnlyScores(
  frames: SampledFrame[],
  weights: SignalWeights
): FrameScore[] {
  return frames.map<FrameScore>((f) => ({
    t: f.t,
    labels: {},
    semantic: 0,
    motion: f.motion,
    saliency: f.saliency,
    focusX: f.focusX,
    focusY: f.focusY,
    score: composite(0, f.motion, f.saliency, weights)
  }));
}

/** True when the cloud frame pass returned at least one real per-label score.
 *  All-empty → cloud unconfigured/blocked → caller falls back on-device. */
export function isCloudResultUsable(scores: FrameScore[]): boolean {
  return scores.some((s) => s.labels && Object.keys(s.labels).length > 0);
}

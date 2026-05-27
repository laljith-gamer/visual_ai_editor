// =====================================================================
// lib/pipeline/adapt.ts — pure functions deriving every selection
// parameter from context (user tier, plan, source video, score
// distribution).
//
// The whole point: instead of "candidates need score >= 0.15", the
// cutoff comes from "give me the top X% of frames where X depends on
// user tier and selection strategy". No fixed thresholds anywhere.
// =====================================================================

import type { EditPlan, ScoreStats, UserTier } from "@/lib/types";
import { ADAPT } from "@/lib/config";

export interface AdaptContext {
  plan: EditPlan;
  videoMeta?: { duration: number; width: number; height: number };
  scoreStats?: ScoreStats;
  userTier?: UserTier;
}

// ---------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------

/**
 * What fraction of the highest-scoring frames count as candidates.
 *   strategy "best"   → narrow (top 15%) — only the strongest
 *   tier "advanced"   → top 20% — respect their precision
 *   tier "novice"     → top 30% — wide net, always returns clips
 *   flat distribution → widen further (no clear peaks)
 */
export function deriveCandidatePercentile(ctx: AdaptContext): number {
  const tier = ctx.userTier ?? "novice";
  const strategy = ctx.plan.selectionStrategy;

  let base: number;
  if (strategy === "best") base = ADAPT.percentile.bestStrategy;
  else if (tier === "advanced") base = ADAPT.percentile.advanced;
  else base = ADAPT.percentile.novice;

  if (ctx.scoreStats) {
    const range = ctx.scoreStats.max - ctx.scoreStats.mean;
    if (range < ADAPT.percentile.flatRangeThreshold) {
      base = Math.min(
        ADAPT.percentile.maxWidened,
        base + ADAPT.percentile.flatBoost
      );
    }
  }
  return base;
}

/** Minimum clip duration. Adapts to source length and tier. */
export function deriveMinClipSeconds(ctx: AdaptContext): number {
  const tier = ctx.userTier ?? "novice";
  const sourceDur = ctx.videoMeta?.duration ?? 60;
  const planMin = ctx.plan.minClipSeconds;

  const adaptiveCap = Math.max(
    ADAPT.minClipSeconds.absoluteFloor,
    Math.min(
      ADAPT.minClipSeconds.absoluteCeiling,
      sourceDur / ADAPT.minClipSeconds.sourceDivisor
    )
  );
  let result = Math.min(planMin, adaptiveCap);
  if (tier === "novice") {
    result = Math.max(
      ADAPT.minClipSeconds.absoluteFloor,
      result * ADAPT.minClipSeconds.noviceFactor
    );
  }
  return result;
}

/** Highlights count guarantee.
 *   novice   → 1 (always usable, even if low confidence)
 *   advanced → 0 (honest "no match" if their query was too specific)
 */
export function deriveForceMinHighlights(ctx: AdaptContext): number {
  return ctx.userTier === "novice"
    ? ADAPT.forceMin.novice
    : ADAPT.forceMin.advanced;
}

// ---------------------------------------------------------------------
// Score statistics
// ---------------------------------------------------------------------

export function computeScoreStats(scores: number[]): ScoreStats {
  if (scores.length === 0) {
    return { count: 0, max: 0, mean: 0, p50: 0, p75: 0, p90: 0 };
  }
  const sorted = [...scores].sort((a, b) => a - b);
  const max = sorted[sorted.length - 1];
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return {
    count: scores.length,
    max,
    mean,
    p50: at(0.5),
    p75: at(0.75),
    p90: at(0.9)
  };
}

export function assessConfidence(score: number): "high" | "medium" | "low" {
  if (score >= ADAPT.confidence.highMin) return "high";
  if (score >= ADAPT.confidence.mediumMin) return "medium";
  return "low";
}

// ---------------------------------------------------------------------
// Diagnostic message builder
// ---------------------------------------------------------------------

/** Build a concrete human explanation of what went wrong / weak. */
export function buildDiagnostic(args: {
  framesScored: number;
  candidatesFound: number;
  highlightsReturned: number;
  scoreStats: ScoreStats;
  cutoff: number;
  percentile: number;
  weakOnly: boolean;
}): string {
  if (args.framesScored === 0) {
    return "Couldn't read frames from the video. Re-upload it and try again.";
  }
  if (args.candidatesFound === 0) {
    const max = args.scoreStats.max.toFixed(2);
    const cutoff = args.cutoff.toFixed(2);
    return [
      `Top frame scored ${max} against your scenarios.`,
      `That's below the candidate cutoff (${(args.percentile * 100).toFixed(0)}% percentile = ${cutoff}).`,
      `Try broader scenarios, or describe a specific moment ("find the part where ___").`
    ].join(" ");
  }
  if (args.highlightsReturned === 0) {
    return [
      `Found ${args.candidatesFound} candidate window${args.candidatesFound === 1 ? "" : "s"}, but they were too short to keep.`,
      `Try a smaller minClipSeconds or different scenarios.`
    ].join(" ");
  }
  if (args.weakOnly) {
    return [
      `Picked ${args.highlightsReturned} clip${args.highlightsReturned === 1 ? "" : "s"}, but confidence is on the lower side.`,
      `Top frame score: ${args.scoreStats.max.toFixed(2)}, mean: ${args.scoreStats.mean.toFixed(2)}.`,
      `Consider broader scenarios for stronger matches.`
    ].join(" ");
  }
  return "";
}

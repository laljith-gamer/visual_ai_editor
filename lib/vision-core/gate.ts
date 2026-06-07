// =====================================================================
// lib/vision-core/gate.ts
//
// The confidence gate — the piece that makes VISION-EDIT-CORE the
// PRIMARY layer with Gemini as an automatic fallback.
//
// Contract:
//   gateVisionCore(output, ctx?) → GateDecision
//
// When `useLocal` is true, the caller renders directly from the engine
// result (adapt.ts) and NEVER calls the cloud planner — $0, offline,
// instant. When false, the caller falls through to POST /api/agent
// exactly as it does today (Gemini → Groq). The gate itself performs no
// I/O and makes no network calls; it only inspects the engine output.
//
// The whole point of a gate (rather than "always use local") is HONESTY:
// the offline engine is strong at structural/visual reasoning
// (best_pick, timeline, sentiment_map) but weak at free-form natural
// language ("every clip with a dog wearing sunglasses"). For anything it
// can't confidently ground, we defer to the LLM instead of shipping a
// wrong cut.
// =====================================================================

import type { VisionCoreOutput, VisionCoreResult } from "@/lib/vision-core/types";

// ---------------------------------------------------------------------
// Thresholds (local to this module — additive, no shared-config churn).
// ---------------------------------------------------------------------

const GATE = {
  /** best_pick: the single strongest scene must clear this highlight
   *  score for the local result to be trusted. Below it, the footage is
   *  flat/low-signal and a language model may reason better. */
  bestPickMinTopHighlight: 0.35,
  /** timeline / sentiment_map: need at least this many connected scenes
   *  for the breakdown to be meaningful. 1 long flat scene → defer. */
  structuralMinScenes: 2,
  /** user_described: minimum relevance of the single best matching scene
   *  required to trust a local match (independent of the engine's own
   *  per-scene min_relevance filter, which controls inclusion). */
  describedMinTopRelevance: 0.5
} as const;

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

export interface GateContext {
  /** Whether a cloud chat provider is configured/available. When false
   *  there is no fallback, so the gate keeps the local result even at
   *  low confidence (a weak local answer beats no answer). */
  hasCloudFallback?: boolean;
}

export interface GateDecision {
  /** True → use the local engine result. False → fall through to the
   *  cloud planner (Gemini → Groq). */
  useLocal: boolean;
  /** Machine-readable reason for the decision. */
  reason: GateReason;
  /** Confidence in the local result, 0..1. Useful for logging / UI. */
  confidence: number;
  /** Present only when useLocal is true: the validated result. */
  result?: VisionCoreResult;
}

export type GateReason =
  // useLocal = true
  | "local_best_pick_strong"
  | "local_structural_ok"
  | "local_described_match"
  | "local_no_fallback_available"
  // useLocal = false (defer to cloud)
  | "engine_error"
  | "empty_segments"
  | "best_pick_too_weak"
  | "too_few_scenes"
  | "no_relevant_scene"
  | "custom_format_unsupported"
  | "unknown_mode";

/**
 * Decide whether to trust the offline engine output or defer to Gemini.
 */
export function gateVisionCore(
  output: VisionCoreOutput,
  ctx: GateContext = {}
): GateDecision {
  const hasFallback = ctx.hasCloudFallback ?? true;

  // Hard failures from the engine → always defer (unless no fallback).
  if (!output.ok) {
    return deferOrKeepError(hasFallback, "engine_error", output);
  }

  const result = output;

  // custom_format is caller-schema-defined; the engine does not yet emit
  // an arbitrary schema, so we defer to the LLM which can. (Kept as an
  // explicit branch so wiring it locally later is a one-line change.)
  if (result.mode === "custom_format") {
    return defer(hasFallback, result, "custom_format_unsupported", 0.2);
  }

  if (result.segments.length === 0) {
    // Distinguish "described but nothing matched" from a generic empty
    // so the caller can log precisely.
    const reason: GateReason =
      result.mode === "user_described" && result.notes === "no_scene_met_min_relevance"
        ? "no_relevant_scene"
        : "empty_segments";
    return defer(hasFallback, result, reason, 0);
  }

  switch (result.mode) {
    case "best_pick": {
      const top = topHighlight(result);
      if (top >= GATE.bestPickMinTopHighlight) {
        return keep(result, "local_best_pick_strong", top);
      }
      return defer(hasFallback, result, "best_pick_too_weak", top);
    }

    case "timeline":
    case "sentiment_map": {
      if (result.stats.scene_count >= GATE.structuralMinScenes) {
        // Confidence scales mildly with scene count, capped at 0.9.
        const conf = Math.min(0.9, 0.5 + result.stats.scene_count * 0.05);
        return keep(result, "local_structural_ok", conf);
      }
      return defer(hasFallback, result, "too_few_scenes", 0.3);
    }

    case "user_described": {
      const topRel = topRelevance(result);
      if (topRel >= GATE.describedMinTopRelevance) {
        return keep(result, "local_described_match", topRel);
      }
      return defer(hasFallback, result, "no_relevant_scene", topRel);
    }

    default:
      return defer(hasFallback, result, "unknown_mode", 0.1);
  }
}

// ---------------------------------------------------------------------
// Decision helpers
// ---------------------------------------------------------------------

function keep(
  result: VisionCoreResult,
  reason: GateReason,
  confidence: number
): GateDecision {
  return { useLocal: true, reason, confidence: clamp01(confidence), result };
}

function defer(
  hasFallback: boolean,
  result: VisionCoreResult,
  reason: GateReason,
  confidence: number
): GateDecision {
  // When there's no cloud fallback configured, a weak local result is
  // still better than nothing — keep it, but report the true (low)
  // confidence and the reason we WOULD have deferred.
  if (!hasFallback) {
    return {
      useLocal: true,
      reason: "local_no_fallback_available",
      confidence: clamp01(confidence),
      result
    };
  }
  return { useLocal: false, reason, confidence: clamp01(confidence) };
}

function deferOrKeepError(
  hasFallback: boolean,
  reason: GateReason,
  _output: VisionCoreOutput
): GateDecision {
  void _output;
  // No result object to keep on a hard error; if there's no fallback the
  // caller must surface its own error path.
  return { useLocal: false, reason, confidence: 0 };
}

// ---------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------

function topHighlight(result: VisionCoreResult): number {
  let top = 0;
  for (const s of result.segments) if (s.scores.highlight > top) top = s.scores.highlight;
  return top;
}

function topRelevance(result: VisionCoreResult): number {
  let top = 0;
  for (const s of result.segments) if (s.scores.relevance > top) top = s.scores.relevance;
  return top;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

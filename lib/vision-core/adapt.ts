// =====================================================================
// lib/vision-core/adapt.ts
//
// Bridge from the VISION-EDIT-CORE output schema to the app's existing
// domain types (Highlight[] / EditPlan). This is what lets a locally
// resolved result flow into the SAME downstream timeline + render path
// the cloud planner already feeds — without changing any of that code.
//
// PURE + DETERMINISTIC, with one explicit, opt-in exception: Highlight
// ids. The shared Highlight type uses `newId("clip")` (nanoid) for ids
// everywhere else in the app, so we follow that convention by default.
// Callers that need byte-for-byte deterministic output (tests) can pass
// a custom id factory.
//
// Nothing here imports from or mutates the existing pipeline. It only
// PRODUCES values shaped like the pipeline's outputs.
// =====================================================================

import type { EditPlan, Highlight, Scenario } from "@/lib/types";
import { PLAN_DEFAULTS, SIGNAL_DEFAULTS } from "@/lib/config";
import { assessConfidence } from "@/lib/pipeline/adapt";
import { newId } from "@/lib/util/id";
import { clamp } from "@/lib/util/time";
import type {
  VisionCoreResult,
  VisionCoreSegment
} from "@/lib/vision-core/types";

// ---------------------------------------------------------------------
// Segments → Highlight[]
// ---------------------------------------------------------------------

export interface AdaptToHighlightsOptions {
  /** Output framing carried onto the plan. Default "vertical". */
  format?: EditPlan["format"];
  /** Transition applied between clips (first clip is always "none").
   *  Default "fade", matching PLAN_DEFAULTS. */
  transition?: EditPlan["transition"];
  /** Which library source these clips come from. Forwarded to each
   *  Highlight.sourceId so the multi-source render graph picks the
   *  right input. Omitted → active source (pipeline default). */
  sourceId?: string;
  /** When true (best_pick), only segments flagged is_best_pick (or all
   *  segments when none are flagged) are emitted. When false
   *  (timeline/described), every segment becomes a clip. Default: emit
   *  best picks if any exist, otherwise all. */
  bestPicksOnly?: boolean;
  /** Total duration ceiling (seconds). Clips are taken in order until
   *  the budget is hit. Omitted → no budget (quality-floor behaviour). */
  budgetSeconds?: number;
  /** Hard cap on clip count. Default PLAN_DEFAULTS.maxClipsWithoutBudget. */
  maxClips?: number;
  /** Deterministic id factory for tests. Default newId("clip"). */
  idFactory?: (index: number) => string;
}

/**
 * Convert engine segments into renderable Highlights.
 *
 * Ordering: best_pick keeps the engine's strongest-first order so the
 * timeline reflects ranking; everything else is sorted ascending by
 * start. Overlap is removed greedily in the chosen order (a later
 * overlapping clip is dropped) so the timeline never double-covers a
 * region — mirroring the existing highlights.ts `overlapsAny` rule.
 */
export function segmentsToHighlights(
  result: VisionCoreResult,
  opts: AdaptToHighlightsOptions = {}
): Highlight[] {
  const transition = opts.transition ?? PLAN_DEFAULTS.transition;
  const maxClips = opts.maxClips ?? PLAN_DEFAULTS.maxClipsWithoutBudget;
  const idFactory = opts.idFactory ?? (() => newId("clip"));

  // Choose the source segments.
  const flagged = result.segments.filter((s) => s.is_best_pick);
  const wantBest =
    opts.bestPicksOnly ?? (flagged.length > 0 && result.mode === "best_pick");
  let source: VisionCoreSegment[];
  if (wantBest && flagged.length > 0) {
    // Preserve best_picks ranking order (ids listed strongest-first).
    const byId = new Map(result.segments.map((s) => [s.id, s]));
    source = result.best_picks
      .map((id) => byId.get(id))
      .filter((s): s is VisionCoreSegment => !!s);
    // Fall back to flagged set if best_picks list was empty.
    if (source.length === 0) source = flagged;
  } else {
    source = [...result.segments].sort((a, b) => a.start - b.start);
  }

  const out: Highlight[] = [];
  let total = 0;
  let emittedIdx = 0;
  for (const seg of source) {
    if (out.length >= maxClips) break;
    const start = round2(Math.min(seg.start, seg.end));
    const end = round2(Math.max(seg.start, seg.end));
    if (end <= start) continue;
    if (overlapsAny(start, end, out)) continue;
    if (opts.budgetSeconds != null && total + (end - start) > opts.budgetSeconds) {
      continue;
    }
    out.push({
      id: idFactory(emittedIdx),
      start,
      end,
      score: clamp(seg.scores.highlight, 0, 1),
      reason: buildReason(seg),
      label: seg.label || undefined,
      transition: emittedIdx === 0 ? "none" : transition,
      confidence: assessConfidence(seg.scores.highlight),
      ...(opts.sourceId ? { sourceId: opts.sourceId } : {})
    });
    total += end - start;
    emittedIdx++;
  }
  return out;
}

function buildReason(seg: VisionCoreSegment): string {
  // Prefer the engine's literal description; fall back to a score-based
  // line. Kept short — this surfaces in the timeline clip tooltip.
  const desc = seg.description?.trim();
  if (desc) return desc.slice(0, 160);
  return `Highlight ${seg.start_tc}\u2013${seg.end_tc} (score ${seg.scores.highlight.toFixed(2)})`;
}

// ---------------------------------------------------------------------
// Result → EditPlan
// ---------------------------------------------------------------------

export interface AdaptToPlanOptions {
  /** The user's original prompt — used to seed a scenario so a later
   *  cloud refinement turn has continuity. */
  prompt?: string;
  format?: EditPlan["format"];
  transition?: EditPlan["transition"];
  /** True only when the user explicitly named a duration; controls the
   *  budgeted vs quality-floor path downstream (see EditPlan docs). */
  userSpecifiedDuration?: boolean;
  /** Target short length when userSpecifiedDuration is true. */
  targetShortSeconds?: number;
  /** Library sources eligible for this plan. */
  sources?: string[];
}

/**
 * Build an EditPlan that mirrors what the engine decided, so the rest of
 * the app (memory chips, refinement turns, render settings) sees a
 * normal plan. The plan is intentionally minimal and valid:
 *   - scenarios: one seeded from the prompt (or empty for pure best_pick)
 *   - signals: visual-interest profile (the engine is signal-driven, not
 *     SigLIP-driven) so a re-run wouldn't fire the semantic pass
 *   - selectionStrategy: "best" for best_pick, "balanced" otherwise
 */
export function resultToEditPlan(
  result: VisionCoreResult,
  opts: AdaptToPlanOptions = {}
): EditPlan {
  const prompt = (opts.prompt ?? "").trim();
  const scenarios: Scenario[] =
    prompt.length > 0
      ? [{ id: "s1", prompt: prompt.slice(0, 200), weight: 1 }]
      : [];
  const labelWeights: Record<string, number> =
    scenarios.length > 0 ? { s1: 1 } : {};

  const userSpecifiedDuration = opts.userSpecifiedDuration ?? false;

  return {
    scenarios,
    labelWeights,
    targetShortSeconds:
      opts.targetShortSeconds ?? PLAN_DEFAULTS.targetShortSeconds,
    userSpecifiedDuration,
    qualityFloor: PLAN_DEFAULTS.qualityFloor,
    maxClipSeconds: PLAN_DEFAULTS.maxClipSeconds,
    minClipSeconds: PLAN_DEFAULTS.minClipSeconds,
    selectionStrategy: result.mode === "best_pick" ? "best" : "balanced",
    format: opts.format ?? PLAN_DEFAULTS.format,
    transition: opts.transition ?? PLAN_DEFAULTS.transition,
    styles: [],
    avoid: [],
    sampleEverySeconds: PLAN_DEFAULTS.sampleEverySeconds,
    inferenceWidth: PLAN_DEFAULTS.inferenceWidth,
    // Visual-interest weights: the engine reasons over motion/saliency,
    // not SigLIP, so semantic=0 keeps a hypothetical re-run cheap.
    signals: { ...SIGNAL_DEFAULTS.visualInterest },
    rationale: result.summary,
    ...(opts.sources && opts.sources.length > 0 ? { sources: opts.sources } : {})
  };
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function overlapsAny(
  start: number,
  end: number,
  others: Highlight[]
): boolean {
  for (const o of others) {
    if (start < o.end && end > o.start) return true;
  }
  return false;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

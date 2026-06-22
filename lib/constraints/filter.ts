// =====================================================================
// lib/constraints/filter.ts
//
// THE HARD GATE.
//
// This is the stage that makes "only lab scenes, ignore everything else"
// behave correctly. It runs AFTER per-frame semantic scoring (we need the
// SigLIP scores to know what a frame depicts) but BEFORE candidate-window
// detection, ranking, and selection. From the selection pipeline's point of
// view, filtering happens before scoring: only the surviving frames are ever
// ranked.
//
// DISTRIBUTION-ADAPTIVE, NOT a fixed threshold. CLIP/SigLIP zero-shot
// similarity is miscalibrated — the same true match scores differently across
// videos — so we never compare against a hardcoded number. Instead we:
//   1. drop frames below a low absolute NOISE floor (concept genuinely absent),
//   2. keep frames whose include match stands out from THIS video's own
//      strongest match (relative cutoff),
//   3. when a hard include can't cover the requested duration, progressively
//      RELAX the cutoff toward the noise floor to admit the next-best-matching
//      footage — so a constrained reel still approaches the target length using
//      on-constraint frames only, never off-constraint "best moments".
//   4. drop frames where an EXCLUDE concept dominates.
//
// NEAREST-MATCH FALLBACK (v2.9): when a HARD include was measurable but no
// frame cleared the noise floor (the strict gate would empty out and the run
// would dead-end with "top score 0.00"), keep the frames the model judged
// CLOSEST to the concept — ranked by include match, still exclude-gated — and
// flag the report `approximate`. No keyword logic; no off-constraint widening.
//
// Pure + import-light. Unit-tested with `node --test`.
// =====================================================================

import type { FrameScore } from "@/lib/types";
import type { ConstraintFilterReport, ConstraintGraph } from "./types";
import { labelFrame } from "./sceneUnderstanding";
import { hasExclude, hasHardInclude, isConstraintDriven } from "./graph";
import { CONSTRAINTS } from "../config";

export interface FilterResult {
  frames: FrameScore[];
  report: ConstraintFilterReport;
}

export interface FilterOptions {
  /** Target reel duration in seconds (when the user named one). Drives the
   *  coverage-aware relaxation so a constrained reel can approach the target
   *  using the best-matching on-constraint footage. */
  targetSeconds?: number | null;
  /** Sampling period (seconds/frame) — converts a surviving frame count into
   *  approximate covered seconds. Defaults to 1. */
  sampleEverySeconds?: number;
}

/**
 * Apply the constraint graph as a HARD GATE over scored frames.
 *
 * Returns the surviving frames plus a report. When the graph is not
 * constraint-driven (no hard include, no exclude) the frames pass through
 * untouched and `hardApplied` is false.
 */
export function applyConstraintFilter(
  frames: FrameScore[],
  graph: ConstraintGraph,
  options: FilterOptions = {}
): FilterResult {
  const inputCount = frames.length;

  if (!isConstraintDriven(graph) || frames.length === 0) {
    return {
      frames,
      report: {
        inputCount,
        keptCount: frames.length,
        droppedByExclude: 0,
        droppedByInclude: 0,
        includeFloor: 0,
        hardApplied: false
      }
    };
  }

  let enforceInclude = hasHardInclude(graph);
  const enforceExclude = hasExclude(graph);

  // Pre-compute each frame's scene label (include/exclude match) once via the
  // scene-understanding layer.
  const matches = frames.map((f) => {
    const label = labelFrame(f, graph);
    return { frame: f, inc: label.includeMatch, exc: label.excludeMatch };
  });

  const maxInclude = matches.reduce((m, x) => Math.max(m, x.inc), 0);
  const maxExclude = matches.reduce((m, x) => Math.max(m, x.exc), 0);

  // GRACEFUL DEGRADATION. If a hard include has NO signal at all across the
  // entire source (maxInclude === 0), semantic scoring was UNAVAILABLE this run
  // — no SigLIP (WebGPU) and no cloud vision — or the concept's scenarios
  // produced nothing. We genuinely cannot MEASURE the constraint, so
  // hard-gating would drop every frame and surface the dreaded
  // "nothing matched (top score 0.00)". Instead we stop enforcing the include
  // and pass frames through, letting motion/saliency selection still build a
  // reel of the requested length; the report flags `unmeasurable` so the
  // caller can be honest that scene matching wasn't possible.
  const includeUnmeasurable = enforceInclude && maxInclude <= 0;
  if (includeUnmeasurable) enforceInclude = false;

  // Exclude cutoff: relative to the strongest exclude match in the source,
  // floored so a clean video doesn't drop frames on noise.
  const excludeCut = Math.max(
    CONSTRAINTS.excludeNoiseFloor,
    maxExclude * CONSTRAINTS.excludeRelativeFraction
  );

  const sampleEvery = options.sampleEverySeconds && options.sampleEverySeconds > 0
    ? options.sampleEverySeconds
    : 1;
  const target = options.targetSeconds && options.targetSeconds > 0 ? options.targetSeconds : 0;

  // The include cutoff starts at the adaptive (relative) level and, only when
  // a hard include can't cover the target duration, relaxes downward toward
  // the noise floor. The noise floor is the hard limit — we never admit a
  // frame the model says doesn't contain the concept.
  const baseCut = enforceInclude
    ? Math.max(CONSTRAINTS.includeNoiseFloor, maxInclude * CONSTRAINTS.includeRelativeFraction)
    : 0;

  const passesExclude = (exc: number, inc: number): boolean => {
    if (!enforceExclude) return true;
    if (exc >= excludeCut) return false;
    if (exc > 0 && exc >= inc + CONSTRAINTS.excludeDominanceMargin) return false;
    return true;
  };

  // Evaluate a candidate include cutoff → surviving frames (exclude-gated).
  const survivorsAt = (incCut: number) =>
    matches.filter((m) => passesExclude(m.exc, m.inc) && (!enforceInclude || m.inc >= incCut));

  let kept = survivorsAt(baseCut);
  let includeFloor = baseCut;

  // Coverage-aware relaxation: if the constraint genuinely can't fill enough
  // of the target, step the cutoff down toward the noise floor and re-admit
  // the next-best on-constraint frames. This is what turns a thin gate into a
  // full-length reel of the requested scene instead of a single clip — while
  // still NEVER including footage below the noise floor or excluded content.
  if (enforceInclude && target > 0) {
    const neededFrames = Math.ceil(
      (target * CONSTRAINTS.coverageTargetFraction) / sampleEvery
    );
    let cut = baseCut;
    while (
      kept.length < neededFrames &&
      cut - CONSTRAINTS.coverageRelaxStep >= CONSTRAINTS.includeNoiseFloor - 1e-9
    ) {
      cut = Math.max(CONSTRAINTS.includeNoiseFloor, cut - CONSTRAINTS.coverageRelaxStep);
      const relaxed = survivorsAt(cut);
      kept = relaxed;
      includeFloor = cut;
      if (cut <= CONSTRAINTS.includeNoiseFloor + 1e-9) break;
    }
  }

  // NEAREST-MATCH GRACEFUL FALLBACK (v2.9, no-hardcode + honest).
  // The strict gate above can legitimately empty out when a HARD include was
  // MEASURABLE (the model produced some signal) yet the STRONGEST match across
  // the whole source still sits below the absolute noise floor — i.e. the
  // concept is present only faintly. A pure hard gate then drops every frame
  // and the run dead-ends with "nothing matched (top score 0.00)".
  //
  // Rather than dead-end, keep the frames the model judged CLOSEST to the
  // concept — ranked by their include match, still subject to the EXCLUDE gate
  // — so the run returns the NEAREST available footage. This uses ONLY the
  // per-frame SigLIP include scores already computed: there is no keyword /
  // genre logic, and it NEVER widens to off-constraint "best moments" (excluded
  // and zero-signal frames are still rejected). The result is flagged
  // `approximate` so the caller presents it as a near, not exact, match.
  let approximate = false;
  if (enforceInclude && kept.length === 0 && maxInclude > 0) {
    const nearest = matches
      .filter((m) => passesExclude(m.exc, m.inc) && m.inc > 0)
      .sort((a, b) => b.inc - a.inc);
    if (nearest.length > 0) {
      // How many of the nearest frames to admit. With a stated duration, cover
      // ~the target length; otherwise keep the cluster that stands out relative
      // to the best near-match (the SAME relative-fraction logic as the strict
      // gate, just without the absolute floor the concept never reached).
      let nearCount: number;
      if (target > 0) {
        const needed = Math.ceil((target * CONSTRAINTS.coverageTargetFraction) / sampleEvery);
        nearCount = Math.min(nearest.length, Math.max(1, needed));
      } else {
        const nearCut = maxInclude * CONSTRAINTS.includeRelativeFraction;
        nearCount = Math.max(1, nearest.filter((m) => m.inc >= nearCut).length);
      }
      kept = nearest.slice(0, nearCount);
      includeFloor = kept[kept.length - 1]?.inc ?? 0;
      approximate = true;
    }
  }

  const keptFrames = kept.map((m) => m.frame);
  const droppedByExclude = matches.filter((m) => !passesExclude(m.exc, m.inc)).length;
  const droppedByInclude = inputCount - keptFrames.length - droppedByExclude;

  return {
    frames: keptFrames,
    report: {
      inputCount,
      keptCount: keptFrames.length,
      droppedByExclude,
      droppedByInclude: Math.max(0, droppedByInclude),
      includeFloor: round3(includeFloor),
      hardApplied: enforceInclude || enforceExclude,
      unmeasurable: includeUnmeasurable,
      approximate
    }
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}


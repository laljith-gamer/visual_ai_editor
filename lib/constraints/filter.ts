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
// Pure + import-light. Unit-tested with `node --test`.
// =====================================================================

import type { CandidateWindow, FrameScore } from "@/lib/types";
import type { ConstraintFilterReport, ConstraintGraph } from "./types";
import { constraintMatch } from "./sceneUnderstanding";
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

  const enforceInclude = hasHardInclude(graph);
  const enforceExclude = hasExclude(graph);

  // Pre-compute per-frame include/exclude matches once.
  const matches = frames.map((f) => ({
    frame: f,
    inc: bestIncludeMatch(f, graph),
    exc: bestExcludeMatch(f, graph)
  }));

  const maxInclude = matches.reduce((m, x) => Math.max(m, x.inc), 0);
  const maxExclude = matches.reduce((m, x) => Math.max(m, x.exc), 0);

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
      hardApplied: true
    }
  };
}

/**
 * Secondary belt-and-braces guard over already-detected candidate windows.
 * Drops windows whose mean include match falls far below the strongest
 * window's, or whose exclude match dominates. Relative, never a fixed number.
 */
export function filterWindows(
  windows: CandidateWindow[],
  graph: ConstraintGraph
): CandidateWindow[] {
  if (!isConstraintDriven(graph) || windows.length === 0) return windows;
  const enforceInclude = hasHardInclude(graph);
  const enforceExclude = hasExclude(graph);

  const stats = windows.map((w) => {
    let incSum = 0;
    let excMax = 0;
    for (const f of w.frames) {
      incSum += bestIncludeMatch(f, graph);
      const e = bestExcludeMatch(f, graph);
      if (e > excMax) excMax = e;
    }
    const incMean = w.frames.length > 0 ? incSum / w.frames.length : 0;
    return { window: w, incMean, excMax };
  });

  const maxMean = stats.reduce((m, s) => Math.max(m, s.incMean), 0);
  const maxExc = stats.reduce((m, s) => Math.max(m, s.excMax), 0);
  const incCut = maxMean * CONSTRAINTS.windowRelativeFraction;
  const excCut = Math.max(
    CONSTRAINTS.excludeNoiseFloor,
    maxExc * CONSTRAINTS.excludeRelativeFraction
  );

  return stats
    .filter((s) => {
      if (s.window.frames.length === 0) return false;
      if (enforceExclude && s.excMax >= excCut) return false;
      if (enforceInclude && s.incMean < incCut) return false;
      return true;
    })
    .map((s) => s.window);
}

function bestIncludeMatch(frame: FrameScore, graph: ConstraintGraph): number {
  let best = 0;
  for (const c of graph.include) {
    const m = constraintMatch(frame, c);
    if (m > best) best = m;
  }
  return best;
}

function bestExcludeMatch(frame: FrameScore, graph: ConstraintGraph): number {
  let best = 0;
  for (const c of graph.exclude) {
    const m = constraintMatch(frame, c);
    if (m > best) best = m;
  }
  return best;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

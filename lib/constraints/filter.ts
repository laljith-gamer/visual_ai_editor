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
// Rules enforced here:
//   - HARD include constraints: keep ONLY frames whose include match clears
//     the floor (absolute + relative-to-source). Everything else is removed.
//   - EXCLUDE constraints: drop frames whose exclude concept matches at/above
//     the ceiling, or dominates the include match.
//   - NEVER widens or "falls back" — if the constrained set is small, it
//     stays small. The composer is responsible for honest under-fill copy.
//   - SOFT-only graphs (no hard include, no exclude) are passed through
//     unchanged: this gate only fires for constraint-driven edits.
//
// Pure + import-light. Unit-tested with `node --test`.
// =====================================================================

import type { CandidateWindow, FrameScore } from "@/lib/types";
import type { ConstraintFilterReport, ConstraintGraph } from "./types";
import { constraintMatch, labelFrame } from "./sceneUnderstanding";
import { hasExclude, hasHardInclude, isConstraintDriven } from "./graph";
import { CONSTRAINTS } from "../config";

export interface FilterResult {
  frames: FrameScore[];
  report: ConstraintFilterReport;
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
  graph: ConstraintGraph
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

  // Adaptive include floor: max(absolute floor, relativeFraction · maxMatch).
  // This keeps the gate meaningful on sources whose SigLIP scores are low
  // overall, without ever admitting off-constraint footage.
  let maxInclude = 0;
  if (enforceInclude) {
    for (const f of frames) {
      const m = bestIncludeMatch(f, graph);
      if (m > maxInclude) maxInclude = m;
    }
  }
  const includeFloor = enforceInclude
    ? Math.max(
        CONSTRAINTS.includeMatchFloor,
        maxInclude * CONSTRAINTS.includeRelativeFraction
      )
    : 0;

  const kept: FrameScore[] = [];
  let droppedByExclude = 0;
  let droppedByInclude = 0;

  for (const f of frames) {
    const label = labelFrame(f, graph);

    // Exclude gate (always hard).
    if (enforceExclude) {
      const excluded =
        label.excludeMatch >= CONSTRAINTS.excludeMatchCeil ||
        (label.excludeMatch > 0 &&
          label.excludeMatch >= label.includeMatch + CONSTRAINTS.excludeDominanceMargin);
      if (excluded) {
        droppedByExclude++;
        continue;
      }
    }

    // Hard include gate.
    if (enforceInclude && label.includeMatch < includeFloor) {
      droppedByInclude++;
      continue;
    }

    kept.push(f);
  }

  return {
    frames: kept,
    report: {
      inputCount,
      keptCount: kept.length,
      droppedByExclude,
      droppedByInclude,
      includeFloor: round3(includeFloor),
      hardApplied: true
    }
  };
}

/**
 * Secondary gate over already-detected candidate windows. Used as a
 * belt-and-braces guard at merge/compose time so a window built from a
 * mixed frame run can't slip excluded content back in. A window survives
 * when its mean include match clears the window floor AND it isn't excluded.
 */
export function filterWindows(
  windows: CandidateWindow[],
  graph: ConstraintGraph
): CandidateWindow[] {
  if (!isConstraintDriven(graph)) return windows;
  const enforceInclude = hasHardInclude(graph);
  const enforceExclude = hasExclude(graph);

  return windows.filter((w) => {
    if (w.frames.length === 0) return false;
    let incSum = 0;
    let excMax = 0;
    for (const f of w.frames) {
      incSum += bestIncludeMatch(f, graph);
      const e = bestExcludeMatch(f, graph);
      if (e > excMax) excMax = e;
    }
    const incMean = incSum / w.frames.length;
    if (enforceExclude && excMax >= CONSTRAINTS.excludeMatchCeil) return false;
    if (enforceInclude && incMean < CONSTRAINTS.windowIncludeFloor) return false;
    return true;
  });
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

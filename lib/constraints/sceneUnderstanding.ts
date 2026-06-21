// =====================================================================
// lib/constraints/sceneUnderstanding.ts
//
// SCENE UNDERSTANDING LAYER.
//
// Turns a scored frame into a SEMANTIC label against the constraint graph.
// The "context embedding" surrogate is the per-constraint SigLIP score
// vector: each include / exclude constraint is measured by the scenario
// label probabilities already attached to the frame (FrameScore.labels),
// NOT by any keyword/string match.
//
// A frame's match to a constraint = the MAX label score across that
// constraint's scenarioIds (OR semantics within a constraint). The frame's
// includeMatch = MAX across include constraints; excludeMatch = MAX across
// exclude constraints. When a constraint has no scenarioIds we fall back to
// the frame's aggregate `semantic` score.
//
// Pure + import-light (type-only imports). Unit-testable with `node --test`.
// =====================================================================

import type { FrameScore } from "@/lib/types";
import type {
  ConstraintGraph,
  SceneLabel,
  SemanticConstraint
} from "./types";

/** Measured match (0..1) of a single frame against one constraint. */
export function constraintMatch(
  frame: FrameScore,
  constraint: SemanticConstraint
): number {
  if (constraint.scenarioIds.length === 0) {
    // No bound scenarios → use the aggregate semantic score as a proxy.
    return clamp01(frame.semantic ?? 0);
  }
  let best = 0;
  for (const sid of constraint.scenarioIds) {
    const v = frame.labels?.[sid];
    if (typeof v === "number" && v > best) best = v;
  }
  return clamp01(best);
}

/** Best match across a list of constraints. */
function bestMatch(frame: FrameScore, constraints: SemanticConstraint[]): {
  match: number;
  id: string | null;
} {
  let match = 0;
  let id: string | null = null;
  for (const c of constraints) {
    const m = constraintMatch(frame, c);
    if (m > match) {
      match = m;
      id = c.id;
    }
  }
  return { match, id };
}

/**
 * Enrich one frame with its constraint-space semantic representation.
 * `sceneType` is the id of the best-matching include constraint (the
 * frame's inferred scene), or null when nothing matched.
 */
export function labelFrame(frame: FrameScore, graph: ConstraintGraph): SceneLabel {
  const vector: Record<string, number> = {};
  for (const c of graph.include) vector[c.id] = constraintMatch(frame, c);
  for (const c of graph.exclude) vector[c.id] = constraintMatch(frame, c);

  const inc = bestMatch(frame, graph.include);
  const exc = bestMatch(frame, graph.exclude);

  return {
    t: frame.t,
    sceneType: inc.id,
    includeMatch: inc.match,
    excludeMatch: exc.match,
    vector
  };
}

/** Label every frame against the graph. */
export function labelFrames(
  frames: FrameScore[],
  graph: ConstraintGraph
): SceneLabel[] {
  return frames.map((f) => labelFrame(f, graph));
}

function clamp01(n: number): number {
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

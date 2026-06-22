// =====================================================================
// lib/constraints/types.ts
//
// THE CONSTRAINT GRAPH — the single source of truth for constraint-driven
// editing. Every user instruction is compiled into one of these objects;
// the whole downstream pipeline (filter → score → compose) reads from it
// and from nothing else.
//
// Design rules:
//   - This file is self-contained: it imports NOTHING from @/lib/types so
//     it can be unit-tested with `node --test --experimental-strip-types`
//     and so lib/types.ts can depend on it without a cycle.
//   - The graph is GENRE-AGNOSTIC. There are no cooking/lab/gaming tables
//     here. A constraint is just a semantic description plus the scenario
//     ids whose SigLIP label scores measure it. Meaning is inferred
//     upstream (the planner LLM / the deterministic intent interpreter),
//     never matched by keyword here.
// =====================================================================

/** HARD = a rule that MUST hold (filtering happens before scoring).
 *  SOFT = a preference that only biases ranking. */
export type ConstraintPriority = "hard" | "soft";

/** What KIND of thing the constraint describes. Used only for explanation
 *  and ordering hints — never for branching logic. */
export type ConstraintKind =
  | "scene"
  | "entity"
  | "action"
  | "domain"
  | "topic";

/**
 * One semantic filter. `scenarioIds` point at entries in
 * `EditPlan.scenarios`; the per-frame SigLIP score for those scenarios is
 * the constraint's measured match (0..1). A constraint with no scenarioIds
 * falls back to the frame's aggregate `semantic` score.
 */
export interface SemanticConstraint {
  id: string;
  /** SigLIP-facing + human-readable description, e.g.
   *  "laboratory / lab interior with equipment". */
  description: string;
  priority: ConstraintPriority;
  kind: ConstraintKind;
  /** Scenario ids in EditPlan.scenarios whose label scores measure this. */
  scenarioIds: string[];
  /** Optional per-constraint minimum semantic match (0..1). Falls back to
   *  CONSTRAINTS.includeMatchFloor / excludeMatchCeil when omitted. */
  matchFloor?: number;
}

/** Optional time-bound the constraint graph carries (mirrors ExtractRange
 *  but lives on the graph so the composer can reason about it). */
export interface TemporalConstraint {
  kind: "first" | "last" | "absolute" | "between";
  startSeconds: number;
  endSeconds: number;
}

/** How the surviving segments are ordered into the final timeline. */
export type NarrativePreference =
  | "chronological"
  | "energy"
  | "story_arc"
  | "as_is";

/**
 * The constraint graph. SINGLE SOURCE OF TRUTH for constraint-driven edits.
 */
export interface ConstraintGraph {
  /** Free-text goal, e.g. "create short video". */
  goal: string;
  /** Hard duration target (seconds) when the user named one. */
  durationSeconds?: number;
  /** True only when the user explicitly stated a duration. */
  userSpecifiedDuration: boolean;
  /** Semantic filters footage MUST (hard) or SHOULD (soft) match. */
  include: SemanticConstraint[];
  /** Semantic filters footage MUST NOT match (always treated as hard). */
  exclude: SemanticConstraint[];
  /** Optional time window the user restricted the edit to. */
  temporal?: TemporalConstraint;
  /** Ordering preference for the composer. Defaults to chronological. */
  narrative: NarrativePreference;
  /**
   * TRUE only when the user EXPLICITLY asked for a highlight / best-moments
   * reel ("highlights", "best parts", "make a reel"). This is the ONLY
   * switch that permits the generic visual-interest "best moments" path.
   * When false, the pipeline never collapses to generic highlights.
   */
  highlightMode: boolean;
}

/** Per-frame semantic labeling result produced by the scene-understanding
 *  layer. `vector` is the constraint-space semantic representation (the
 *  "context embedding" surrogate built from SigLIP label scores). */
export interface SceneLabel {
  t: number;
  /** Id of the best-matching include constraint, or null when none match. */
  sceneType: string | null;
  /** Max semantic match across include constraints. 0..1. */
  includeMatch: number;
  /** Max semantic match across exclude constraints. 0..1. */
  excludeMatch: number;
  /** Per-constraint scores (id → 0..1). The semantic representation. */
  vector: Record<string, number>;
}

/** Report returned by the hard gate so the pipeline + activity log can
 *  explain exactly what the constraint filter did. */
export interface ConstraintFilterReport {
  inputCount: number;
  keptCount: number;
  droppedByExclude: number;
  droppedByInclude: number;
  /** Effective include floor used. */
  includeFloor: number;
  /** Whether a HARD gate actually ran (vs a pass-through). */
  hardApplied: boolean;
  /** v2.8 — true when a hard include could not be MEASURED at all (no semantic
   *  signal across the whole source: SigLIP/cloud vision unavailable this run).
   *  The gate degrades to a pass-through so the pipeline still builds a reel
   *  from motion/saliency, and the caller can be honest that scene matching
   *  wasn't possible. */
  unmeasurable?: boolean;
}

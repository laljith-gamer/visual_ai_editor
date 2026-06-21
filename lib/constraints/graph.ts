// =====================================================================
// lib/constraints/graph.ts
//
// Builder + helpers for the CONSTRAINT GRAPH (lib/constraints/types.ts).
//
// The graph is compiled from already-inferred meaning — the planner LLM's
// scenarios/avoid, or the deterministic intent interpreter's subject tokens
// + exclusivity flag. There is NO keyword/genre matching in here: a
// constraint is a semantic description plus the scenario ids whose SigLIP
// label scores measure it.
//
// Two responsibilities:
//   1. buildConstraintGraph()      — turn intent hints into a graph and the
//                                     exclude scenarios that must be SigLIP-
//                                     scored (so excludes are semantic, not
//                                     keyword).
//   2. normalizeConstraintGraph()  — sanitise a raw graph the planner LLM
//                                     emitted on EditPlan.constraints.
//
// Dependency-light: value import from "../config" only; types are
// `import type` (stripped by the Node test runner). Unit-tested with
// `node --test`.
// =====================================================================

import type { Scenario } from "@/lib/types";
import type {
  ConstraintGraph,
  ConstraintPriority,
  NarrativePreference,
  SemanticConstraint,
  TemporalConstraint
} from "./types";
import { CONSTRAINTS } from "../config";

export interface ConstraintGraphInput {
  /** Free-text goal, e.g. "create short video". */
  goal?: string;
  /** Include scenarios already present on the plan (id + prompt). */
  scenarios: Array<{ id: string; prompt: string }>;
  /** "only" / "just" / "alone" / "nothing but" / "ignore everything else"
   *  → the include constraints become HARD (filter before scoring). */
  exclusiveOnly: boolean;
  /** Semantic subjects the user asked to exclude ("avoid intro" → ["intro"]).
   *  Each becomes an exclude constraint AND an exclude scenario so SigLIP
   *  scores it — excludes are semantic, never keyword string-matches. */
  excludeSubjects?: string[];
  /** True when the request is a generic "best parts/highlights/reel" ask
   *  with no concrete subject. Enables highlightMode. */
  genericBestParts?: boolean;
  /** True when the user EXPLICITLY asked for highlights / best moments. */
  highlightRequested?: boolean;
  /** Stated duration target in seconds, or null. */
  targetSeconds?: number | null;
  userSpecifiedDuration?: boolean;
  /** Optional time window the edit is restricted to. */
  temporal?: TemporalConstraint | null;
  narrative?: NarrativePreference;
}

export interface BuiltConstraintGraph {
  graph: ConstraintGraph;
  /** Exclude scenarios to append to EditPlan.scenarios. They carry weight 0
   *  so they are SigLIP-scored (their match lands in FrameScore.labels) but
   *  never contribute to the include `semantic` aggregate. */
  excludeScenarios: Scenario[];
}

function slug(s: string, fallback: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32) || fallback
  );
}

/**
 * Compile intent hints into a constraint graph.
 *
 * Behaviour summary:
 *   - exclusiveOnly  → every include constraint is HARD (drop non-matching
 *                      footage before scoring). Otherwise SOFT (bias only).
 *   - excludeSubjects→ a HARD exclude constraint + a weight-0 exclude
 *                      scenario per subject.
 *   - generic/highlightRequested → highlightMode true (the ONLY way the
 *                      generic best-moments path is allowed).
 */
export function buildConstraintGraph(
  input: ConstraintGraphInput
): BuiltConstraintGraph {
  const priority: ConstraintPriority = input.exclusiveOnly ? "hard" : "soft";
  const include: SemanticConstraint[] = [];
  const seen = new Set<string>();

  for (const s of input.scenarios) {
    const prompt = (s.prompt ?? "").trim();
    if (!prompt) continue;
    let id = `inc_${s.id}`;
    while (seen.has(id)) id = `${id}_x`;
    seen.add(id);
    include.push({
      id,
      description: prompt.slice(0, 200),
      priority,
      kind: "topic",
      scenarioIds: [s.id]
    });
  }

  const excludeScenarios: Scenario[] = [];
  const exclude: SemanticConstraint[] = [];
  const subjects = dedupeStrings(input.excludeSubjects ?? []);
  for (const subj of subjects) {
    const clean = subj.trim();
    if (clean.length < 2) continue;
    const scenarioId = slug(`exclude ${clean}`, `exclude_${exclude.length}`);
    // weight 0 → scored by SigLIP, ignored by the include aggregate.
    excludeScenarios.push({ id: scenarioId, prompt: clean.slice(0, 200), weight: 0 });
    exclude.push({
      id: `exc_${scenarioId}`,
      description: clean.slice(0, 200),
      priority: "hard",
      kind: "topic",
      scenarioIds: [scenarioId]
    });
  }

  const highlightMode =
    Boolean(input.genericBestParts) || Boolean(input.highlightRequested);

  const graph: ConstraintGraph = {
    goal: (input.goal ?? "create short video").slice(0, 120),
    include,
    exclude,
    narrative: input.narrative ?? "chronological",
    userSpecifiedDuration: input.userSpecifiedDuration === true,
    highlightMode,
    ...(typeof input.targetSeconds === "number" && input.targetSeconds > 0
      ? { durationSeconds: Math.round(input.targetSeconds) }
      : {}),
    ...(input.temporal ? { temporal: input.temporal } : {})
  };

  return { graph, excludeScenarios };
}

// ---------------------------------------------------------------------
// Predicates the pipeline branches on.
// ---------------------------------------------------------------------

/** True when at least one include constraint is HARD. */
export function hasHardInclude(graph: ConstraintGraph | undefined | null): boolean {
  return !!graph && graph.include.some((c) => c.priority === "hard");
}

/** True when there is at least one exclude constraint. Excludes are always
 *  enforced as hard rules. */
export function hasExclude(graph: ConstraintGraph | undefined | null): boolean {
  return !!graph && graph.exclude.length > 0;
}

/**
 * The central decision: is this a CONSTRAINT-DRIVEN edit (hard filtering
 * required) vs a normal/soft edit? True when there's a hard include or any
 * exclude. When true the pipeline must filter BEFORE scoring and must NOT
 * fall back to generic highlights.
 */
export function isConstraintDriven(
  graph: ConstraintGraph | undefined | null
): boolean {
  return hasHardInclude(graph) || hasExclude(graph);
}

/** All scenario ids referenced by include constraints. */
export function includeScenarioIds(graph: ConstraintGraph): string[] {
  return uniq(graph.include.flatMap((c) => c.scenarioIds));
}

/** All scenario ids referenced by exclude constraints. */
export function excludeScenarioIds(graph: ConstraintGraph): string[] {
  return uniq(graph.exclude.flatMap((c) => c.scenarioIds));
}

/** Compact, stable signature for cache keys. */
export function constraintGraphSignature(
  graph: ConstraintGraph | undefined | null
): string {
  if (!graph) return "none";
  return JSON.stringify({
    inc: graph.include.map((c) => ({ p: c.priority, s: c.scenarioIds })),
    exc: graph.exclude.map((c) => ({ s: c.scenarioIds })),
    hl: graph.highlightMode,
    d: graph.durationSeconds ?? null,
    t: graph.temporal ?? null
  });
}

// ---------------------------------------------------------------------
// normalizeConstraintGraph — sanitise an LLM-emitted graph.
// ---------------------------------------------------------------------

/**
 * Validate + clamp a raw `constraints` object the planner emitted on its
 * EditPlan. Unknown / malformed fields are dropped. `knownScenarioIds`
 * lets us discard dangling scenarioId references the LLM may have
 * hallucinated. Returns null when nothing usable survives.
 */
export function normalizeConstraintGraph(
  raw: unknown,
  knownScenarioIds: string[]
): ConstraintGraph | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const known = new Set(knownScenarioIds);

  const include = normalizeConstraintList(r.include, known, "soft");
  const exclude = normalizeConstraintList(r.exclude, known, "hard").map((c) => ({
    ...c,
    priority: "hard" as ConstraintPriority
  }));

  const highlightMode = r.highlightMode === true;

  // Nothing actionable → let the caller skip attaching a graph.
  if (include.length === 0 && exclude.length === 0 && !highlightMode) {
    return null;
  }

  const narrative = oneOfNarrative(r.narrative);
  const durationSeconds =
    typeof r.durationSeconds === "number" && isFinite(r.durationSeconds) && r.durationSeconds > 0
      ? Math.round(r.durationSeconds)
      : undefined;

  return {
    goal:
      typeof r.goal === "string" && r.goal.trim()
        ? r.goal.trim().slice(0, 120)
        : "create short video",
    include,
    exclude,
    narrative,
    userSpecifiedDuration: r.userSpecifiedDuration === true,
    highlightMode,
    ...(durationSeconds ? { durationSeconds } : {}),
    ...(normalizeTemporal(r.temporal) ? { temporal: normalizeTemporal(r.temporal)! } : {})
  };
}

function normalizeConstraintList(
  raw: unknown,
  known: Set<string>,
  defaultPriority: ConstraintPriority
): SemanticConstraint[] {
  if (!Array.isArray(raw)) return [];
  const out: SemanticConstraint[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const description =
      typeof o.description === "string" ? o.description.trim() : "";
    if (!description) continue;
    const scenarioIds = Array.isArray(o.scenarioIds)
      ? o.scenarioIds.filter(
          (x): x is string => typeof x === "string" && known.has(x)
        )
      : [];
    // A constraint with no resolvable scenarioIds cannot be MEASURED (there's
    // no scored scenario behind it). Dropping it avoids the footgun where an
    // exclude with no scenario falls back to the include aggregate and wrongly
    // drops matching frames. The deterministic builder always binds ids; this
    // only discards malformed/hallucinated LLM constraints.
    if (scenarioIds.length === 0) continue;
    const priority: ConstraintPriority =
      o.priority === "hard" || o.priority === "soft"
        ? o.priority
        : defaultPriority;
    let id =
      typeof o.id === "string" && o.id.trim()
        ? o.id.trim().slice(0, 48)
        : slug(description, `c_${out.length}`);
    while (seen.has(id)) id = `${id}_${out.length}`;
    seen.add(id);
    out.push({
      id,
      description: description.slice(0, 200),
      priority,
      kind: normalizeKind(o.kind),
      scenarioIds,
      ...(typeof o.matchFloor === "number" && isFinite(o.matchFloor)
        ? { matchFloor: clamp01(o.matchFloor) }
        : {})
    });
    if (out.length >= 8) break;
  }
  return out;
}

function normalizeKind(v: unknown): SemanticConstraint["kind"] {
  return v === "scene" || v === "entity" || v === "action" || v === "domain" || v === "topic"
    ? v
    : "topic";
}

function oneOfNarrative(v: unknown): NarrativePreference {
  return v === "energy" || v === "story_arc" || v === "as_is" || v === "chronological"
    ? v
    : "chronological";
}

function normalizeTemporal(raw: unknown): TemporalConstraint | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind =
    r.kind === "first" || r.kind === "last" || r.kind === "absolute" || r.kind === "between"
      ? r.kind
      : "absolute";
  const start =
    typeof r.startSeconds === "number" && isFinite(r.startSeconds)
      ? Math.max(0, r.startSeconds)
      : 0;
  const end =
    typeof r.endSeconds === "number" && isFinite(r.endSeconds)
      ? Math.max(0, r.endSeconds)
      : 0;
  if (kind !== "last" && end <= start) return null;
  if (kind === "last" && end <= 0) return null;
  return { kind, startSeconds: start, endSeconds: end };
}

// ---------------------------------------------------------------------
// tiny pure helpers
// ---------------------------------------------------------------------

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function uniq(xs: string[]): string[] {
  return Array.from(new Set(xs));
}

function dedupeStrings(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const k = (x ?? "").trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x.trim());
  }
  return out;
}

// Re-export the config so call sites that want the floors can read one place.
export { CONSTRAINTS } from "../config";

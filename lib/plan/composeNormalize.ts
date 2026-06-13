// =====================================================================
// lib/plan/composeNormalize.ts
//
// Defensive normaliser for the planner's COMPOSE envelope. Mirrors the
// clamp-everything style of the other mode normalisers in
// app/api/agent/route.ts: never trust raw LLM JSON shapes, never throw —
// return a clean MultiSourceComposePlan or null when there isn't enough to
// build a montage (caller falls back to clarify).
//
// Dependency-free at runtime (only `import type`) so it can be unit-tested
// with `node --test --experimental-strip-types`.
// =====================================================================

import type {
  ComposeOrdering,
  ComposeRole,
  ComposeSourceRef,
  ComposeSourceRefType,
  ComposeSourceSelection,
  ComposeTransition,
  ComposeTransitionType,
  MultiSourceComposePlan
} from "@/lib/types";

const REF_TYPES: ComposeSourceRefType[] = [
  "active",
  "selected",
  "index",
  "id",
  "filename_hint",
  "semantic_hint"
];
const ROLES: ComposeRole[] = [
  "main",
  "insert",
  "segment",
  "intro",
  "middle",
  "ending"
];
const ORDERINGS: ComposeOrdering["type"][] = [
  "source_order",
  "user_mentioned_order",
  "interleave",
  "shuffle",
  "story_arc",
  "energy_curve"
];
const TRANSITIONS: ComposeTransitionType[] = [
  "auto",
  "cut",
  "fade",
  "crossfade",
  "glitch",
  "whip",
  "zoom",
  "match_cut"
];

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const p = Number(v);
    if (Number.isFinite(p)) return p;
  }
  return undefined;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function oneOf<T extends string>(v: unknown, allowed: T[]): T | undefined {
  return typeof v === "string" && (allowed as string[]).includes(v)
    ? (v as T)
    : undefined;
}

function normalizeRef(raw: unknown): ComposeSourceRef | null {
  const r = obj(raw);
  const type = oneOf<ComposeSourceRefType>(r.type, REF_TYPES);
  if (!type) {
    // Be forgiving: an explicit sourceId or index implies the type.
    if (typeof r.sourceId === "string" && r.sourceId.trim()) {
      return { type: "id", sourceId: r.sourceId.trim().slice(0, 64) };
    }
    const i = num(r.index);
    if (i !== undefined) return { type: "index", index: Math.trunc(i) };
    return null;
  }
  const ref: ComposeSourceRef = { type };
  if (type === "id") {
    const id = str(r.sourceId, 64);
    if (!id) return null;
    ref.sourceId = id;
  } else if (type === "index") {
    const i = num(r.index);
    if (i === undefined || i < 0) return null;
    ref.index = Math.trunc(i);
  } else if (type === "filename_hint" || type === "semantic_hint") {
    const hint = str(r.hint, 120);
    if (!hint) return null;
    ref.hint = hint;
  }
  return ref;
}

function normalizeSelection(raw: unknown): ComposeSourceSelection | null {
  const r = obj(raw);
  const sourceRef = normalizeRef(r.sourceRef);
  if (!sourceRef) return null;
  const sel: ComposeSourceSelection = {
    sourceRef,
    query: str(r.query, 200) ?? ""
  };
  const role = oneOf<ComposeRole>(r.role, ROLES);
  if (role) sel.role = role;
  const order = num(r.order);
  if (order !== undefined && order >= 0) sel.order = Math.trunc(order);
  const clipCount = num(r.clipCount);
  if (clipCount !== undefined && clipCount >= 1) {
    sel.clipCount = Math.trunc(clamp(clipCount, 1, 12));
  }
  const durationSeconds = num(r.durationSeconds);
  if (durationSeconds !== undefined && durationSeconds > 0) {
    sel.durationSeconds = clamp(durationSeconds, 0.5, 600);
  }
  return sel;
}

/**
 * Normalise the planner's compose envelope. Returns null when fewer than
 * one source selection survives sanitation (nothing to compose).
 */
export function normalizeComposePlan(
  raw: unknown
): MultiSourceComposePlan | null {
  const r = obj(raw);

  const rawSources = Array.isArray(r.sources) ? r.sources : [];
  const sources: ComposeSourceSelection[] = [];
  for (const s of rawSources.slice(0, 8)) {
    const sel = normalizeSelection(s);
    if (sel) sources.push(sel);
  }
  if (sources.length === 0) return null;

  const orderingRaw = obj(r.ordering);
  const ordering: ComposeOrdering = {
    type: oneOf<ComposeOrdering["type"]>(orderingRaw.type, ORDERINGS) ?? "source_order",
    ...(orderingRaw.anchorFirst === true ? { anchorFirst: true } : {})
  };

  const transitionRaw = obj(r.transition);
  const transition: ComposeTransition = {
    type: oneOf<ComposeTransitionType>(transitionRaw.type, TRANSITIONS) ?? "auto"
  };
  const tDur = num(transitionRaw.durationSeconds);
  if (tDur !== undefined && tDur > 0) {
    transition.durationSeconds = clamp(tDur, 0.1, 5);
  }
  const dynamicRule = str(transitionRaw.dynamicRule, 200);
  if (dynamicRule) transition.dynamicRule = dynamicRule;

  const outputRaw = obj(r.outputTarget);
  const name = str(outputRaw.name, 60);

  const plan: MultiSourceComposePlan = {
    outputTarget: { type: "new_timeline_slot", ...(name ? { name } : {}) },
    sources,
    ordering,
    transition,
    needsAnalysis: r.needsAnalysis === false ? false : true
  };

  const targetSeconds = num(r.targetSeconds);
  if (targetSeconds !== undefined && targetSeconds > 0) {
    plan.targetSeconds = clamp(targetSeconds, 2, 600);
    plan.userSpecifiedDuration = true;
  }
  if (r.userSpecifiedDuration === true) plan.userSpecifiedDuration = true;
  if (r.userSpecifiedDuration === false && plan.targetSeconds === undefined) {
    plan.userSpecifiedDuration = false;
  }

  return plan;
}

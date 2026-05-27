import type { EditPlan, PlanPatch, Scenario } from "@/lib/types";
import { newId } from "@/lib/util/id";
import { clamp } from "@/lib/util/time";
import { PLAN_BOUNDS, PLAN_DEFAULTS } from "@/lib/config";

/**
 * Validate and normalize a raw plan from the LLM into a clean EditPlan
 * (or surface what's missing). Unlike v1.0.0, this NEVER silently
 * substitutes a fake fallback scenario — when scenarios are missing the
 * caller is expected to switch the response to clarify mode.
 */

export interface NormalizeResult {
  plan: EditPlan | null;
  /** Field paths the planner failed to provide; non-empty → caller should clarify. */
  missing: string[];
  warnings: string[];
}

/** Normalize an LLM-emitted plan object. */
export function normalizePlan(raw: unknown): NormalizeResult {
  const warnings: string[] = [];
  const missing: string[] = [];
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  const scenarios = normalizeScenarios(r.scenarios);
  if (scenarios.length === 0) {
    missing.push("scenarios");
    return { plan: null, missing, warnings };
  }

  const labelWeights = normalizeLabelWeights(r.labelWeights, scenarios);

  const target = numberOrDefault(
    r.targetShortSeconds,
    PLAN_DEFAULTS.targetShortSeconds,
    PLAN_BOUNDS.targetShortSeconds
  );
  const maxClip = numberOrDefault(
    r.maxClipSeconds,
    PLAN_DEFAULTS.maxClipSeconds,
    { min: PLAN_BOUNDS.maxClipSeconds.min, max: Math.min(PLAN_BOUNDS.maxClipSeconds.max, target) }
  );
  const minClip = numberOrDefault(
    r.minClipSeconds,
    Math.min(PLAN_DEFAULTS.minClipSeconds, maxClip),
    { min: PLAN_BOUNDS.minClipSeconds.min, max: Math.min(PLAN_BOUNDS.minClipSeconds.max, maxClip) }
  );

  const format = oneOf(r.format, ["vertical", "horizontal", "square"], PLAN_DEFAULTS.format);
  const transition = oneOf(r.transition, ["none", "fade", "crossfade"], PLAN_DEFAULTS.transition);
  const selectionStrategy = oneOf(
    r.selectionStrategy,
    ["balanced", "best"],
    PLAN_DEFAULTS.selectionStrategy
  );

  const sampleEvery = numberOrDefault(
    r.sampleEverySeconds,
    PLAN_DEFAULTS.sampleEverySeconds,
    PLAN_BOUNDS.sampleEverySeconds
  );
  const inferenceWidth = Math.round(
    numberOrDefault(r.inferenceWidth, PLAN_DEFAULTS.inferenceWidth, PLAN_BOUNDS.inferenceWidth)
  );

  const styles = stringArray(r.styles).slice(0, PLAN_BOUNDS.styleCount.max);
  const avoid = stringArray(r.avoid).slice(0, PLAN_BOUNDS.styleCount.max);
  const rationale =
    typeof r.rationale === "string" && r.rationale.trim()
      ? r.rationale.trim().slice(0, 600)
      : undefined;

  return {
    plan: {
      scenarios,
      labelWeights,
      targetShortSeconds: target,
      maxClipSeconds: maxClip,
      minClipSeconds: minClip,
      selectionStrategy,
      format,
      transition,
      styles,
      avoid,
      sampleEverySeconds: sampleEvery,
      inferenceWidth,
      rationale
    },
    missing: [],
    warnings
  };
}

/** Normalize a partial plan (refinement patch). Doesn't require scenarios. */
export function normalizePlanPatch(raw: unknown): {
  patch: PlanPatch;
  warnings: string[];
} {
  const warnings: string[] = [];
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const patch: PlanPatch = {};

  if (Array.isArray(r.scenarios)) {
    const scenarios = normalizeScenarios(r.scenarios);
    if (scenarios.length > 0) patch.scenarios = scenarios;
  }
  if (
    r.scenariosOp === "replace" ||
    r.scenariosOp === "append" ||
    r.scenariosOp === "remove"
  ) {
    patch.scenariosOp = r.scenariosOp;
  }
  if (r.labelWeights && typeof r.labelWeights === "object") {
    const lw: Record<string, number> = {};
    for (const [k, v] of Object.entries(r.labelWeights as Record<string, unknown>)) {
      if (typeof v === "number" && isFinite(v)) {
        lw[k] = clamp(v, PLAN_BOUNDS.scenarioWeight.min, PLAN_BOUNDS.scenarioWeight.max);
      }
    }
    patch.labelWeights = lw;
  }
  if (typeof r.targetShortSeconds === "number") {
    patch.targetShortSeconds = clampToBound(r.targetShortSeconds, PLAN_BOUNDS.targetShortSeconds);
  }
  if (typeof r.maxClipSeconds === "number") {
    patch.maxClipSeconds = clampToBound(r.maxClipSeconds, PLAN_BOUNDS.maxClipSeconds);
  }
  if (typeof r.minClipSeconds === "number") {
    patch.minClipSeconds = clampToBound(r.minClipSeconds, PLAN_BOUNDS.minClipSeconds);
  }
  if (typeof r.sampleEverySeconds === "number") {
    patch.sampleEverySeconds = clampToBound(
      r.sampleEverySeconds,
      PLAN_BOUNDS.sampleEverySeconds
    );
  }
  if (typeof r.inferenceWidth === "number") {
    patch.inferenceWidth = Math.round(
      clampToBound(r.inferenceWidth, PLAN_BOUNDS.inferenceWidth)
    );
  }
  if (typeof r.format === "string" && ["vertical", "horizontal", "square"].includes(r.format)) {
    patch.format = r.format as EditPlan["format"];
  }
  if (typeof r.transition === "string" && ["none", "fade", "crossfade"].includes(r.transition)) {
    patch.transition = r.transition as EditPlan["transition"];
  }
  if (
    typeof r.selectionStrategy === "string" &&
    ["balanced", "best"].includes(r.selectionStrategy)
  ) {
    patch.selectionStrategy = r.selectionStrategy as EditPlan["selectionStrategy"];
  }
  if (Array.isArray(r.styles)) {
    patch.styles = stringArray(r.styles).slice(0, PLAN_BOUNDS.styleCount.max);
  }
  if (Array.isArray(r.avoid)) {
    patch.avoid = stringArray(r.avoid).slice(0, PLAN_BOUNDS.styleCount.max);
  }
  if (typeof r.rationale === "string" && r.rationale.trim()) {
    patch.rationale = r.rationale.trim().slice(0, 600);
  }
  return { patch, warnings };
}

/** Stable signature used as the predictions cache key. */
export function planSignaturePayload(plan: EditPlan): string {
  return JSON.stringify({
    scenarios: plan.scenarios.map((s) => ({ id: s.id, prompt: s.prompt })),
    sampleEverySeconds: plan.sampleEverySeconds,
    inferenceWidth: plan.inferenceWidth
  });
}

// ---------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------

function normalizeScenarios(raw: unknown): Scenario[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Scenario[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const promptText = typeof obj.prompt === "string" ? obj.prompt.trim() : "";
    if (!promptText) continue;
    let id =
      typeof obj.id === "string" && obj.id.trim()
        ? obj.id.trim().slice(0, 48)
        : promptText.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 24) ||
          newId("s");
    while (seen.has(id)) id = `${id}_${out.length}`;
    seen.add(id);
    const weight =
      typeof obj.weight === "number" && isFinite(obj.weight)
        ? clamp(obj.weight, PLAN_BOUNDS.scenarioWeight.min, PLAN_BOUNDS.scenarioWeight.max)
        : 1;
    out.push({ id, prompt: promptText.slice(0, 200), weight });
    if (out.length >= PLAN_BOUNDS.scenarioCount.max) break;
  }
  return out;
}

function normalizeLabelWeights(
  raw: unknown,
  scenarios: Scenario[]
): Record<string, number> {
  const out: Record<string, number> = {};
  const map = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  for (const s of scenarios) {
    const v = map[s.id];
    out[s.id] =
      typeof v === "number" && isFinite(v)
        ? clamp(v, PLAN_BOUNDS.scenarioWeight.min, PLAN_BOUNDS.scenarioWeight.max)
        : s.weight ?? 1;
  }
  const sum = Object.values(out).reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    const equal = 1 / scenarios.length;
    for (const k of Object.keys(out)) out[k] = equal;
  } else if (Math.abs(sum - 1) > 0.01) {
    for (const k of Object.keys(out)) out[k] = out[k] / sum;
  }
  return out;
}

function numberOrDefault(
  v: unknown,
  def: number,
  bound: { min: number; max: number }
): number {
  if (typeof v === "number" && isFinite(v)) return clamp(v, bound.min, bound.max);
  if (typeof v === "string") {
    const parsed = parseFloat(v);
    if (isFinite(parsed)) return clamp(parsed, bound.min, bound.max);
  }
  return clamp(def, bound.min, bound.max);
}

function clampToBound(value: number, bound: { min: number; max: number }): number {
  return clamp(value, bound.min, bound.max);
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], def: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : def;
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

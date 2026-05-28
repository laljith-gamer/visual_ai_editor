import type { EditPlan, PlanPatch, Scenario } from "@/lib/types";
import { PLAN_BOUNDS } from "@/lib/config";
import { clamp } from "@/lib/util/time";

/**
 * Merge a partial plan patch into an existing plan, preserving fields the
 * patch didn't mention. Used for refinement turns ("make it shorter",
 * "vertical please") so the pipeline doesn't restart from a blank plan.
 *
 * Policy notes (see .kiro/steering/conversation-patterns.md):
 *   - scenariosOp = "replace" (default), "append", or "remove"
 *   - styles + avoid are merged distinct, capped at PLAN_BOUNDS.styleCount.max
 *   - labelWeights re-balance after any scenario change
 *   - all numeric fields clamped to PLAN_BOUNDS
 */
export function mergePlan(current: EditPlan, patch: PlanPatch): EditPlan {
  const out: EditPlan = { ...current };

  // --- scenarios -----------------------------------------------------
  if (patch.scenarios && Array.isArray(patch.scenarios)) {
    const op = patch.scenariosOp ?? "replace";
    if (op === "replace") {
      out.scenarios = dedupeScenarios(patch.scenarios);
    } else if (op === "append") {
      out.scenarios = dedupeScenarios([...current.scenarios, ...patch.scenarios]);
    } else if (op === "remove") {
      const drop = new Set(patch.scenarios.map((s) => s.id));
      out.scenarios = current.scenarios.filter((s) => !drop.has(s.id));
    }
    out.scenarios = out.scenarios.slice(0, PLAN_BOUNDS.scenarioCount.max);
    if (out.scenarios.length === 0) {
      // Refusing to leave a plan with zero scenarios; fall back to current.
      out.scenarios = current.scenarios;
    }
  }

  // --- labelWeights --------------------------------------------------
  if (patch.labelWeights) {
    out.labelWeights = { ...patch.labelWeights };
  }
  // Whether or not weights were patched, ensure they're consistent with
  // the (possibly new) scenarios array and renormalised.
  out.labelWeights = rebalanceLabelWeights(out.scenarios, out.labelWeights);

  // --- numeric fields with bounds ------------------------------------
  if (typeof patch.targetShortSeconds === "number") {
    out.targetShortSeconds = clampBound(
      patch.targetShortSeconds,
      PLAN_BOUNDS.targetShortSeconds
    );
    // v1.7.1 — any explicit duration on a patch flips the plan into
    // user-specified mode (the pipeline now enforces budget). The
    // patch may also set userSpecifiedDuration explicitly; we honour
    // that below if the planner emitted it.
    out.userSpecifiedDuration = true;
  }
  if (typeof patch.userSpecifiedDuration === "boolean") {
    out.userSpecifiedDuration = patch.userSpecifiedDuration;
  }
  if (typeof patch.qualityFloor === "number") {
    out.qualityFloor = clamp(patch.qualityFloor, 0, 1);
  }
  if (typeof patch.maxClipSeconds === "number") {
    out.maxClipSeconds = clampBound(patch.maxClipSeconds, PLAN_BOUNDS.maxClipSeconds);
  }
  if (typeof patch.minClipSeconds === "number") {
    out.minClipSeconds = clampBound(patch.minClipSeconds, PLAN_BOUNDS.minClipSeconds);
  }
  if (typeof patch.sampleEverySeconds === "number") {
    out.sampleEverySeconds = clampBound(
      patch.sampleEverySeconds,
      PLAN_BOUNDS.sampleEverySeconds
    );
  }
  if (typeof patch.inferenceWidth === "number") {
    out.inferenceWidth = Math.round(
      clampBound(patch.inferenceWidth, PLAN_BOUNDS.inferenceWidth)
    );
  }
  // Cross-field consistency: minClip ≤ maxClip ≤ target.
  out.minClipSeconds = Math.min(out.minClipSeconds, out.maxClipSeconds);
  out.maxClipSeconds = Math.min(out.maxClipSeconds, out.targetShortSeconds);

  // --- enums ---------------------------------------------------------
  if (patch.format) out.format = patch.format;
  if (patch.transition) out.transition = patch.transition;
  if (patch.selectionStrategy) out.selectionStrategy = patch.selectionStrategy;

  // --- string arrays (distinct, bounded) -----------------------------
  if (patch.styles) {
    out.styles = mergeDistinct(current.styles, patch.styles, PLAN_BOUNDS.styleCount.max);
  }
  if (patch.avoid) {
    out.avoid = mergeDistinct(current.avoid, patch.avoid, PLAN_BOUNDS.styleCount.max);
  }

  // --- rationale -----------------------------------------------------
  if (typeof patch.rationale === "string" && patch.rationale.trim()) {
    out.rationale = patch.rationale.slice(0, 600);
  }

  // --- v1.5.0: signals + extractRange -------------------------------
  if (patch.signals) {
    out.signals = patch.signals;
  }
  if (patch.extractRange) {
    out.extractRange = patch.extractRange;
  }

  return out;
}

/** Build a fresh plan when there's no current plan to merge into. */
export function planFromPatch(patch: PlanPatch, fallback: EditPlan): EditPlan {
  return mergePlan(fallback, patch);
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function clampBound(value: number, bound: { min: number; max: number }): number {
  return clamp(value, bound.min, bound.max);
}

function dedupeScenarios(list: Scenario[]): Scenario[] {
  const seen = new Set<string>();
  const out: Scenario[] = [];
  for (const s of list) {
    if (!s || typeof s.id !== "string" || !s.id || !s.prompt) continue;
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push({
      id: s.id.slice(0, 48),
      prompt: s.prompt.slice(0, 200),
      weight:
        typeof s.weight === "number" && isFinite(s.weight)
          ? clampBound(s.weight, PLAN_BOUNDS.scenarioWeight)
          : 1
    });
  }
  return out;
}

function rebalanceLabelWeights(
  scenarios: Scenario[],
  raw: Record<string, number>
): Record<string, number> {
  const out: Record<string, number> = {};
  if (scenarios.length === 0) return out;
  for (const s of scenarios) {
    const v = raw[s.id];
    out[s.id] =
      typeof v === "number" && isFinite(v)
        ? clampBound(v, PLAN_BOUNDS.scenarioWeight)
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

function mergeDistinct(a: string[], b: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [...a, ...b]) {
    const trimmed = (item || "").trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

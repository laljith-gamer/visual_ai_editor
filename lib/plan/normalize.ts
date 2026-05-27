import type { EditPlan, Scenario } from "@/lib/types";
import { newId } from "@/lib/util/id";
import { clamp } from "@/lib/util/time";

/**
 * Validate and normalize a raw plan from the LLM. Always returns a usable plan,
 * filling sensible defaults for missing fields. Logs warnings into `warnings`.
 */
export function normalizePlan(
  raw: unknown,
  warnings: string[] = []
): EditPlan {
  const r = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {});

  const scenarios = normalizeScenarios(r.scenarios, warnings);
  const labelWeights = normalizeLabelWeights(r.labelWeights, scenarios, warnings);

  const target = numberOrDefault(r.targetShortSeconds, 30, 5, 600);
  const maxClip = numberOrDefault(r.maxClipSeconds, 8, 1, target);
  const minClip = numberOrDefault(r.minClipSeconds, 1.5, 0.5, maxClip);

  const format = oneOf(r.format, ["vertical", "horizontal", "square"], "vertical");
  const transition = oneOf(r.transition, ["none", "fade", "crossfade"], "fade");
  const selectionStrategy = oneOf(r.selectionStrategy, ["balanced", "best"], "balanced");

  const sampleEvery = numberOrDefault(r.sampleEverySeconds, 1, 0.25, 10);
  const inferenceWidth = Math.round(numberOrDefault(r.inferenceWidth, 256, 128, 768));

  const styles = stringArray(r.styles).slice(0, 8);
  const avoid = stringArray(r.avoid).slice(0, 8);
  const rationale = typeof r.rationale === "string" ? r.rationale.slice(0, 600) : undefined;

  return {
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
  };
}

function normalizeScenarios(raw: unknown, warnings: string[]): Scenario[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    warnings.push("plan.scenarios missing or empty; using a generic fallback");
    return [
      { id: "highlight", prompt: "visually engaging moment", weight: 1 }
    ];
  }
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
        ? clamp(obj.weight, 0, 5)
        : 1;
    out.push({ id, prompt: promptText.slice(0, 200), weight });
    if (out.length >= 6) break;
  }
  if (!out.length) {
    warnings.push("plan.scenarios had no valid entries; using fallback");
    return [{ id: "highlight", prompt: "visually engaging moment", weight: 1 }];
  }
  return out;
}

function normalizeLabelWeights(
  raw: unknown,
  scenarios: Scenario[],
  warnings: string[]
): Record<string, number> {
  const out: Record<string, number> = {};
  const map = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {});
  for (const s of scenarios) {
    const v = map[s.id];
    if (typeof v === "number" && isFinite(v)) {
      out[s.id] = clamp(v, 0, 5);
    } else {
      out[s.id] = s.weight ?? 1;
    }
  }
  // Normalize so the sum is ~1
  const sum = Object.values(out).reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    warnings.push("labelWeights summed to 0; rebalancing equally");
    const equal = 1 / scenarios.length;
    for (const s of scenarios) out[s.id] = equal;
  } else if (Math.abs(sum - 1) > 0.01) {
    for (const k of Object.keys(out)) out[k] = out[k] / sum;
  }
  return out;
}

function numberOrDefault(v: unknown, def: number, min: number, max: number): number {
  if (typeof v === "number" && isFinite(v)) return clamp(v, min, max);
  if (typeof v === "string") {
    const parsed = parseFloat(v);
    if (isFinite(parsed)) return clamp(parsed, min, max);
  }
  return def;
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

/** Stable signature for cache key — same scenarios + sample params = same key. */
export function planSignaturePayload(plan: EditPlan): string {
  return JSON.stringify({
    scenarios: plan.scenarios.map((s) => ({ id: s.id, prompt: s.prompt })),
    sampleEverySeconds: plan.sampleEverySeconds,
    inferenceWidth: plan.inferenceWidth
  });
}

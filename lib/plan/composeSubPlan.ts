// =====================================================================
// lib/plan/composeSubPlan.ts
//
// Turns ONE ComposeSourceSelection into a single-source EditPlan that the
// real per-source pipeline (executeForSource) can run. This is the bridge
// that keeps compose mode honest: each source's clips are picked by the
// actual sample → score → temporal → buildHighlights flow, never faked.
//
// Imports config (PLAN_DEFAULTS / PLAN_BOUNDS), so this module is NOT part
// of the import-free unit-test set — it's covered by typecheck + build.
// =====================================================================

import { PLAN_DEFAULTS, PLAN_BOUNDS } from "@/lib/config";
import type {
  ComposeSourceSelection,
  EditPlan,
  MultiSourceComposePlan
} from "@/lib/types";

function slugify(text: string, fallback: string): string {
  const s = (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return s || fallback;
}

/**
 * Build the single-source EditPlan for one montage contribution.
 *
 *  - A non-empty `query` becomes one semantic scenario (SigLIP runs).
 *  - An empty / vibe query ("best", "anything") drops to the
 *    motion+saliency visual-interest path (semantic skipped), matching the
 *    planner's documented "best parts" behaviour.
 *  - `durationSeconds` makes the per-source run budgeted (so it pulls
 *    roughly that many seconds); otherwise the quality-floor path runs and
 *    the caller trims by `clipCount` afterwards.
 *
 * `selectionStrategy` is "best" because a montage wants each source's top
 * moments, not an even spread.
 */
export function buildComposeSubPlan(
  selection: ComposeSourceSelection,
  compose: MultiSourceComposePlan,
  index: number
): EditPlan {
  const query = (selection.query || "").trim();
  const vibeOnly =
    query === "" || /^(best|any|anything|cool|interesting|good)\b/i.test(query);

  const id = slugify(query, `compose_${index}`);
  const scenarios = vibeOnly
    ? []
    : [{ id, prompt: query.slice(0, 200), weight: 1 }];
  const labelWeights = vibeOnly ? {} : { [id]: 1 };
  const signals = vibeOnly
    ? { semantic: 0, motion: 0.6, saliency: 0.4 }
    : { semantic: 0.6, motion: 0.3, saliency: 0.1 };

  const hasDuration =
    typeof selection.durationSeconds === "number" &&
    selection.durationSeconds > 0;
  const target = hasDuration
    ? Math.min(
        PLAN_BOUNDS.targetShortSeconds.max,
        Math.max(PLAN_BOUNDS.targetShortSeconds.min, selection.durationSeconds as number)
      )
    : PLAN_DEFAULTS.targetShortSeconds;

  const maxClipSeconds = Math.min(
    PLAN_DEFAULTS.maxClipSeconds,
    hasDuration ? (selection.durationSeconds as number) : PLAN_DEFAULTS.maxClipSeconds
  );

  return {
    scenarios,
    labelWeights,
    targetShortSeconds: target,
    userSpecifiedDuration: hasDuration,
    qualityFloor: PLAN_DEFAULTS.qualityFloor,
    maxClipSeconds: Math.max(PLAN_BOUNDS.maxClipSeconds.min, maxClipSeconds),
    minClipSeconds: Math.min(PLAN_DEFAULTS.minClipSeconds, maxClipSeconds),
    selectionStrategy: "best",
    format: PLAN_DEFAULTS.format,
    // Transitions are assigned globally by the compose assembler; per-source
    // value is irrelevant here.
    transition: "none",
    styles: [],
    avoid: [],
    sampleEverySeconds: PLAN_DEFAULTS.sampleEverySeconds,
    inferenceWidth: PLAN_DEFAULTS.inferenceWidth,
    signals,
    // Pin to this one source so cache signatures + scoring stay per-source.
    sources: undefined,
    rationale: `Compose montage — source ${index + 1}${
      compose.outputTarget.name ? ` of ${compose.outputTarget.name}` : ""
    }`
  };
}

/**
 * Build a minimal EditPlan that carries the compose run's OUTPUT preferences
 * (format + target duration) so the render path picks them up. Compose lays
 * clips on the timeline without a plan; without this, a "vertical" request
 * would silently fall back to the source's native aspect at render time.
 * Scenarios are intentionally empty — this plan only conveys output framing.
 */
export function buildComposeOutputPlan(
  compose: MultiSourceComposePlan
): EditPlan {
  const target =
    compose.targetSeconds && compose.targetSeconds > 0
      ? Math.min(
          PLAN_BOUNDS.targetShortSeconds.max,
          Math.max(PLAN_BOUNDS.targetShortSeconds.min, compose.targetSeconds)
        )
      : PLAN_DEFAULTS.targetShortSeconds;
  return {
    scenarios: [],
    labelWeights: {},
    targetShortSeconds: target,
    userSpecifiedDuration: compose.userSpecifiedDuration === true,
    qualityFloor: PLAN_DEFAULTS.qualityFloor,
    maxClipSeconds: PLAN_DEFAULTS.maxClipSeconds,
    minClipSeconds: PLAN_DEFAULTS.minClipSeconds,
    selectionStrategy: PLAN_DEFAULTS.selectionStrategy,
    format: compose.format ?? PLAN_DEFAULTS.format,
    transition: PLAN_DEFAULTS.transition,
    styles: [],
    avoid: [],
    sampleEverySeconds: PLAN_DEFAULTS.sampleEverySeconds,
    inferenceWidth: PLAN_DEFAULTS.inferenceWidth,
    signals: { semantic: 0, motion: 0.6, saliency: 0.4 },
    sources: undefined,
    rationale: compose.outputTarget.name
      ? `Compose output — ${compose.outputTarget.name}`
      : "Compose output"
  };
}

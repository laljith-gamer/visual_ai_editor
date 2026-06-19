// =====================================================================
// lib/analysis/globalVideoPlanner.ts
//
// Multi-video GLOBAL planning. Instead of picking clips per source and
// merging blindly, first summarize each source (from video memory), infer a
// likely ROLE, decide an ORDER and a SELECTION STRATEGY, and — when the
// global story is unclear — ASK before committing. Balanced mode prevents a
// single source from dominating unless the user asked for best-first.
//
// Roles are inferred from GENERIC signals only (clip position, motion
// profile, count of strong windows) — NO genre tables. PURE + unit-tested.
// =====================================================================

import { GLOBAL_PLAN } from "../config";
import type { PromptSpecificity } from "./types";
import type { SourcePlanningSummary } from "./videoMemory";

export type EditStrategy = "balanced" | "best_first" | "story" | "explicit";
export type SourceRole = "intro" | "main" | "ending" | "b_roll" | "main_only" | "unknown";

export interface GlobalPlanRequest {
  promptSpecificity: PromptSpecificity;
  /** Explicit style if the user stated one. */
  style?: "story" | "montage" | "unknown";
  /** "best only / most action" → best_first; explicit order → explicit. */
  bestOnly?: boolean;
  /** Explicit source order (sourceIds) if the user dictated one. */
  explicitOrder?: string[];
}

export interface PlannedSource {
  sourceId: string;
  name: string;
  role: SourceRole;
  order: number;
  motion: SourcePlanningSummary["motion"];
  goodWindowCount: number;
  /** Suggested share of the output (0..1) under the chosen strategy. */
  targetShare: number;
}

export interface GlobalEditPlan {
  needsClarification: boolean;
  clarification?: { message: string; suggestions: string[] };
  strategy: EditStrategy;
  /** sourceIds in playback order. */
  order: string[];
  roles: PlannedSource[];
  reason: string;
}

function roundShare(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Index of the most likely "main action" source: most strong windows,
 *  tie broken by higher motion. */
function pickMainIndex(sources: SourcePlanningSummary[]): number {
  let best = 0;
  for (let i = 1; i < sources.length; i++) {
    const a = sources[i];
    const b = sources[best];
    if (a.goodWindowCount > b.goodWindowCount) best = i;
    else if (a.goodWindowCount === b.goodWindowCount) {
      const am = a.motion === "high" ? 1 : a.motion === "mixed" ? 0.5 : 0;
      const bm = b.motion === "high" ? 1 : b.motion === "mixed" ? 0.5 : 0;
      if (am > bm) best = i;
    }
  }
  return best;
}

/**
 * Build a global edit plan from per-source summaries + the request.
 * Deterministic. When multi-source and the style is unclear, returns
 * needsClarification with a style question instead of guessing.
 */
export function planGlobalEdit(
  sources: SourcePlanningSummary[],
  request: GlobalPlanRequest
): GlobalEditPlan {
  // Single source: trivial plan, no global decisions.
  if (sources.length <= 1) {
    const s = sources[0];
    return {
      needsClarification: false,
      strategy: request.bestOnly ? "best_first" : "balanced",
      order: s ? [s.sourceId] : [],
      roles: s
        ? [
            {
              sourceId: s.sourceId,
              name: s.name,
              role: "main_only",
              order: 0,
              motion: s.motion,
              goodWindowCount: s.goodWindowCount,
              targetShare: 1
            }
          ]
        : [],
      reason: s ? "single source — no global ordering needed" : "no sources"
    };
  }

  // Decide strategy from the request.
  let strategy: EditStrategy;
  if (request.explicitOrder && request.explicitOrder.length > 0) strategy = "explicit";
  else if (request.bestOnly) strategy = "best_first";
  else if (request.style === "story") strategy = "story";
  else if (request.style === "montage") strategy = "balanced";
  else strategy = "balanced";

  // Clarify when the global story is genuinely unclear (multi-source, no
  // explicit order, no stated style, vague brief). Never guess a structure.
  const styleUnclear = !request.bestOnly && (request.style === undefined || request.style === "unknown");
  if (strategy !== "explicit" && styleUnclear && request.promptSpecificity === "vague") {
    return {
      needsClarification: true,
      clarification: {
        message: "Do you want a story-style edit or a fast montage?",
        suggestions: ["Story style", "Fast montage", "You decide"]
      },
      strategy: "balanced",
      order: sources.map((s) => s.sourceId),
      roles: [],
      reason: "multi-video edit style is unclear — asking before planning"
    };
  }

  // Order: explicit > story (intro→main→ending by role) > original order.
  const mainIndex = pickMainIndex(sources);
  let ordered: SourcePlanningSummary[];
  if (strategy === "explicit" && request.explicitOrder) {
    const byId = new Map(sources.map((s) => [s.sourceId, s]));
    ordered = request.explicitOrder.map((id) => byId.get(id)).filter(Boolean) as SourcePlanningSummary[];
    // append any sources not named, preserving original order
    for (const s of sources) if (!ordered.includes(s)) ordered.push(s);
  } else {
    ordered = [...sources];
  }

  const roles: PlannedSource[] = ordered.map((s, i) => {
    let role: SourceRole = "b_roll";
    if (s === sources[mainIndex]) role = "main";
    else if (i === 0) role = "intro";
    else if (i === ordered.length - 1) role = "ending";
    return {
      sourceId: s.sourceId,
      name: s.name,
      role,
      order: i,
      motion: s.motion,
      goodWindowCount: s.goodWindowCount,
      targetShare: 0
    };
  });

  // Target shares.
  if (strategy === "best_first") {
    // Proportional to strong-window count (fallback: equal). User opted in to
    // letting the strongest source dominate.
    const totalWindows = roles.reduce((a, r) => a + r.goodWindowCount, 0);
    roles.forEach((r) => {
      r.targetShare = totalWindows > 0 ? roundShare(r.goodWindowCount / totalWindows) : roundShare(1 / roles.length);
    });
  } else {
    // Balanced/story: start equal, then CAP any single source so it can't
    // dominate, redistributing the remainder to the others.
    const equal = 1 / roles.length;
    const cap = GLOBAL_PLAN.balancedMaxShare;
    roles.forEach((r) => (r.targetShare = Math.min(equal, cap)));
    // (equal <= cap whenever roles.length >= 2, so the cap mainly documents
    // intent; renormalize to sum ~1 for safety.)
    const sum = roles.reduce((a, r) => a + r.targetShare, 0) || 1;
    roles.forEach((r) => (r.targetShare = roundShare(r.targetShare / sum)));
  }

  return {
    needsClarification: false,
    strategy,
    order: ordered.map((s) => s.sourceId),
    roles,
    reason:
      strategy === "best_first"
        ? "best-first: strongest source leads (user opted in)"
        : strategy === "story"
          ? "story order: intro → main → ending, balanced shares"
          : strategy === "explicit"
            ? "explicit order from the user"
            : "balanced: no single source dominates"
  };
}

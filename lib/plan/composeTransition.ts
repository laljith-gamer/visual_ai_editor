// =====================================================================
// lib/plan/composeTransition.ts
//
// Pure transition resolver for multi-source COMPOSE (montage) mode.
//
// IMPORTANT honesty note: the render worker only supports three real
// transitions — `none` (hard cut), `fade`, and `crossfade`. The planner is
// allowed to REQUEST a richer vocabulary (glitch / whip / zoom / match_cut)
// so we can capture intent and label it in the UI, but every request is
// mapped DOWN to the closest renderable transition here. We never pretend
// to render an effect the pipeline can't actually produce.
//
// When the planner asks for "auto" we pick a transition per boundary from
// the two clips' topical categories (derived from the planner-supplied
// query text — montage aesthetic only, never raw user text).
//
// Dependency-free at runtime (only `import type`) so it can be unit-tested
// with `node --test --experimental-strip-types`.
// =====================================================================

import type {
  ComposeRole,
  ComposeTransition,
  ComposeTransitionType
} from "@/lib/types";

/** The only transitions the ffmpeg render worker can actually apply. */
export type RenderTransition = "none" | "fade" | "crossfade";

export interface ResolvedTransition {
  /** What the render worker will actually apply. */
  render: RenderTransition;
  /** What was asked for / dynamically chosen — surfaced in UI copy so the
   *  user knows their "glitch" became a crossfade, etc. */
  intended: ComposeTransitionType;
}

/** Endpoint of a boundary: the clip's query + narrative role. */
export interface BoundaryClip {
  query: string;
  role?: ComposeRole;
}

type Category =
  | "action"
  | "dialogue"
  | "joke"
  | "ingredient"
  | "final_dish"
  | "other";

/** Keyword buckets used ONLY to pick a transition aesthetic between two
 *  clips. Operates on the planner's query text, not the raw user prompt. */
const CATEGORY_KEYWORDS: Array<[Category, string[]]> = [
  ["action", ["action", "combat", "fight", "battle", "gameplay", "chase", "stunt", "sport", "dance", "kill", "attack", "race", "explosion"]],
  ["dialogue", ["cutscene", "dialogue", "dialog", "story", "talk", "interview", "speech", "conversation", "narrative", "monologue", "scene"]],
  ["joke", ["joke", "funny", "meme", "comedy", "laugh", "reaction", "gag", "bloop", "fail"]],
  ["final_dish", ["final dish", "plating", "plated", "finished dish", "reveal", "result", "final result", "serve", "presentation"]],
  ["ingredient", ["ingredient", "ingredients", "prep", "chopping", "mixing"]]
];

export function categorizeQuery(query: string, role?: ComposeRole): Category {
  const q = (query || "").toLowerCase();
  for (const [cat, words] of CATEGORY_KEYWORDS) {
    if (words.some((w) => q.includes(w))) return cat;
  }
  // Roles give a weak topical hint when the query is generic.
  if (role === "ending") return "final_dish";
  return "other";
}

/** Map any requested transition type to the closest renderable one. */
export function mapToRender(type: ComposeTransitionType): RenderTransition {
  switch (type) {
    case "fade":
      return "fade";
    case "crossfade":
    case "whip":
    case "zoom":
    case "glitch":
      // Blends/effects we can't do for real → closest smooth blend.
      return "crossfade";
    case "cut":
    case "match_cut":
      // A match cut is, at render level, a clean hard cut.
      return "none";
    case "auto":
    default:
      return "fade";
  }
}

/** Dynamic per-boundary intent from the two clips' categories. */
function dynamicIntent(prev: Category, next: Category): ComposeTransitionType {
  // action → action: keep the energy, hard cut.
  if (prev === "action" && next === "action") return "cut";
  // action → story/cutscene: whip into the calmer beat.
  if (prev === "action" && next === "dialogue") return "whip";
  // story/cutscene → action: punch straight in.
  if (prev === "dialogue" && next === "action") return "cut";
  // joke/meme → anything: quick pop cut.
  if (prev === "joke") return "cut";
  // ingredients → final dish: soft fade.
  if (prev === "ingredient" && next === "final_dish") return "fade";
  // Calm-to-calm or unknown: a gentle fade reads best.
  if (prev === "dialogue" && next === "dialogue") return "crossfade";
  return "fade";
}

/**
 * Resolve the transition for the boundary BEFORE `next` (i.e. the
 * transition that plays as we cut from `prev` into `next`).
 *
 * - Explicit (non-"auto") requests apply uniformly, mapped to render.
 * - "auto" derives a per-boundary intent from the clip categories, then
 *   maps that to a renderable transition.
 */
export function resolveComposeTransition(
  spec: ComposeTransition,
  prev: BoundaryClip,
  next: BoundaryClip
): ResolvedTransition {
  if (spec.type !== "auto") {
    return { render: mapToRender(spec.type), intended: spec.type };
  }
  const intended = dynamicIntent(
    categorizeQuery(prev.query, prev.role),
    categorizeQuery(next.query, next.role)
  );
  return { render: mapToRender(intended), intended };
}

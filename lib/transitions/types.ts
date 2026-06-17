/**
 * PR 58 — per-boundary transition model (foundation).
 *
 * Production needs DIFFERENT transitions at DIFFERENT clip boundaries, not
 * one global transition. This module defines that model. It does NOT yet
 * change the render worker or add UI — those are follow-ups (see the issue
 * #57 PR 58 acceptance). For now the model is captured + honestly mapped
 * down to what the worker can actually render (lib/transitions/map.ts).
 *
 * Honesty: only `cut`/`fade`/`crossfade` are truly rendered today. The
 * richer vocabulary is accepted so intent can be stored/labelled, but it
 * is mapped down and the UI must say so — never claim glitch/whip/etc. are
 * rendered.
 */

import { TRANSITIONS } from "../config";

/** Full transition vocabulary the editor can REQUEST / store. */
export type TransitionType =
  | "cut"
  | "fade"
  | "crossfade"
  | "dip_to_black"
  | "slide"
  | "zoom"
  | "glitch"
  | "whip"
  | "match_cut";

/** What the ffmpeg render worker can ACTUALLY apply today. */
export type RenderableTransition = "none" | "fade" | "crossfade";

/** Whether a boundary transition was chosen automatically or pinned by the
 *  user. Manual transitions survive an auto recompute. */
export type TransitionMode = "auto" | "manual";

export const ALL_TRANSITION_TYPES: readonly TransitionType[] = [
  "cut",
  "fade",
  "crossfade",
  "dip_to_black",
  "slide",
  "zoom",
  "glitch",
  "whip",
  "match_cut"
] as const;

/**
 * A transition that plays at ONE boundary (between the clip before it and
 * the clip after it). `index` is the boundary position: boundary `i` sits
 * between timeline clip `i-1` and clip `i` (boundary 0 = the lead-in to the
 * first clip, which renders as a hard cut/none).
 *
 * The first three fields are the original PR 58 foundation; the rest are
 * OPTIONAL enrichment added for auto-picking (PR 59) so older callers and
 * the existing tests keep working unchanged. `mapTransition` fills
 * render/exact/note; `selectAutoTransition` fills mode/confidence/reason/
 * evidence.
 */
export interface BoundaryTransition {
  /** Boundary index (0 = before the first clip). */
  index: number;
  type: TransitionType;
  /** Duration in seconds; defaults applied via `withTransitionDefaults`. */
  durationSeconds?: number;
  /** "auto" (engine-chosen) or "manual" (user-pinned). Default treated as
   *  "manual" by callers that don't set it. */
  mode?: TransitionMode;
  /** 0..1 confidence for an auto pick. */
  confidence?: number;
  /** Human-readable why ("same source and adjacent time"). */
  reason?: string;
  /** The generic signals that drove the pick (no genre tables). */
  evidence?: string[];
  /** What the worker will actually render (from `mapTransition`). */
  render?: RenderableTransition;
  /** True iff `render` reproduces `type` exactly. */
  exact?: boolean;
  /** Honest down-map note when `!exact`. */
  note?: string;
}

/** True for the three transition types the render worker implements. */
export function isRenderImplemented(type: TransitionType): boolean {
  return type === "cut" || type === "fade" || type === "crossfade";
}

/** Clamp + default a transition duration using the centralized guardrails. */
export function normalizeTransitionDuration(seconds?: number): number {
  const d = typeof seconds === "number" && seconds > 0 ? seconds : TRANSITIONS.defaultDurationSeconds;
  return Math.min(d, TRANSITIONS.maxDurationSeconds);
}

/** Fill in a boundary transition's default duration. Returns the input
 *  with a guaranteed numeric `durationSeconds` (other optional enrichment
 *  fields pass through untouched). */
export function withTransitionDefaults(
  bt: BoundaryTransition
): BoundaryTransition & { durationSeconds: number } {
  return {
    ...bt,
    durationSeconds: normalizeTransitionDuration(bt.durationSeconds)
  };
}

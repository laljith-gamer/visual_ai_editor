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
 */
export interface BoundaryTransition {
  /** Boundary index (0 = before the first clip). */
  index: number;
  type: TransitionType;
  /** Duration in seconds; defaults applied via `withTransitionDefaults`. */
  durationSeconds?: number;
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

/** Fill in a boundary transition's default duration. */
export function withTransitionDefaults(bt: BoundaryTransition): Required<BoundaryTransition> {
  return {
    index: bt.index,
    type: bt.type,
    durationSeconds: normalizeTransitionDuration(bt.durationSeconds)
  };
}

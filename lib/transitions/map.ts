/**
 * PR 58 — honest transition mapping.
 *
 * Maps any requested `TransitionType` to the single renderable transition
 * the ffmpeg worker can actually apply today (`none`/`fade`/`crossfade`),
 * and reports whether that mapping is EXACT. When it isn't, a `note`
 * explains the down-map so the UI can be honest ("Zoom isn't rendered yet
 * — using a crossfade") rather than claiming an effect we don't produce.
 *
 * Pure + dependency-free → unit-testable with `node --test`.
 */

import type { RenderableTransition, TransitionType } from "./types";

export interface MappedTransition {
  /** The transition that was requested. */
  intended: TransitionType;
  /** What the render worker will actually apply. */
  render: RenderableTransition;
  /** Short human label for the intended transition. */
  label: string;
  /** True iff `render` reproduces `intended` exactly (no quality loss). */
  exact: boolean;
  /** When `!exact`: an honest one-line explanation of the down-map. */
  note?: string;
}

interface Entry {
  render: RenderableTransition;
  label: string;
  exact: boolean;
  /** Phrase describing the intended effect for the down-map note. */
  effect?: string;
}

// Single source of truth for the mapping. cut/fade/crossfade are exact
// (the worker implements them). Everything else is captured for intent but
// mapped to the closest real transition and flagged not-exact.
const TABLE: Record<TransitionType, Entry> = {
  cut: { render: "none", label: "Cut", exact: true },
  fade: { render: "fade", label: "Fade", exact: true },
  crossfade: { render: "crossfade", label: "Crossfade", exact: true },
  dip_to_black: { render: "fade", label: "Dip to black", exact: false, effect: "Dip to black" },
  slide: { render: "crossfade", label: "Slide", exact: false, effect: "Slide" },
  zoom: { render: "crossfade", label: "Zoom", exact: false, effect: "Zoom" },
  glitch: { render: "crossfade", label: "Glitch", exact: false, effect: "Glitch" },
  whip: { render: "crossfade", label: "Whip pan", exact: false, effect: "Whip pan" },
  match_cut: { render: "none", label: "Match cut", exact: false, effect: "Match cut" }
};

function renderName(r: RenderableTransition): string {
  return r === "none" ? "a hard cut" : `a ${r}`;
}

/** Map a requested transition to a renderable one, honestly. */
export function mapTransition(type: TransitionType): MappedTransition {
  const entry = TABLE[type] ?? TABLE.cut;
  const base: MappedTransition = {
    intended: type,
    render: entry.render,
    label: entry.label,
    exact: entry.exact
  };
  if (!entry.exact) {
    base.note = `${entry.effect ?? entry.label} isn't rendered yet — using ${renderName(entry.render)}.`;
  }
  return base;
}

/** Convenience: just the renderable transition for the render worker. */
export function toRenderable(type: TransitionType): RenderableTransition {
  return (TABLE[type] ?? TABLE.cut).render;
}

/** Build a single honest sentence covering any transitions that were
 *  mapped down, or "" when every transition renders exactly. Useful for a
 *  one-line chat/UI notice. */
export function describeMappedDowns(types: TransitionType[]): string {
  const downs = Array.from(new Set(types))
    .map(mapTransition)
    .filter((m) => !m.exact);
  if (downs.length === 0) return "";
  const parts = downs.map((m) => `${m.label} → ${m.render === "none" ? "cut" : m.render}`);
  return `Some transitions aren't rendered yet and were mapped to the closest real one: ${parts.join(", ")}.`;
}

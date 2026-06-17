/**
 * PR 59 — build per-boundary transitions for a whole timeline.
 *
 * `buildAutoBoundaryTransitions` produces one `BoundaryTransition` for each
 * adjacent clip pair (boundary index `i` sits between clip `i-1` and clip
 * `i`, so indices run 1..N-1). It:
 *   - auto-picks each boundary via `selectAutoTransition`, BUT
 *   - preserves any existing MANUAL override whose boundary still exists,
 *   - drops manual overrides whose boundary disappeared (fewer clips),
 *   - clamps each transition's duration so it can't eat a short clip.
 *
 * Pure → unit-testable. Render/UI consume the result; the editor recomputes
 * it whenever the timeline changes.
 */

import { selectAutoTransition } from "./auto";
import { mapTransition } from "./map";
import type { TransitionClip, TransitionContext } from "./features";
import { normalizeTransitionDuration, type BoundaryTransition } from "./types";

export interface BuildBoundariesOptions {
  context?: TransitionContext;
  /** Existing transitions; entries with mode "manual" are preserved when
   *  their boundary index still exists. */
  existing?: BoundaryTransition[];
}

export function buildAutoBoundaryTransitions(
  highlights: TransitionClip[],
  options: BuildBoundariesOptions = {}
): BoundaryTransition[] {
  if (!Array.isArray(highlights) || highlights.length < 2) return [];

  const manualByIndex = new Map<number, BoundaryTransition>();
  for (const bt of options.existing ?? []) {
    if (bt.mode === "manual") manualByIndex.set(bt.index, bt);
  }

  const out: BoundaryTransition[] = [];
  for (let i = 1; i < highlights.length; i++) {
    const prev = highlights[i - 1];
    const next = highlights[i];
    const maxDur = clampForPair(prev, next);

    const manual = manualByIndex.get(i);
    if (manual) {
      // Re-map render/exact/note (in case the table changed) and re-clamp
      // duration to the current clip lengths; keep the user's type/mode.
      const mapped = mapTransition(manual.type);
      out.push({
        ...manual,
        index: i,
        mode: "manual",
        durationSeconds: Math.min(normalizeTransitionDuration(manual.durationSeconds), maxDur),
        render: mapped.render,
        exact: mapped.exact,
        note: mapped.note
      });
      continue;
    }

    const auto = selectAutoTransition(prev, next, options.context, { index: i });
    auto.durationSeconds = Math.min(
      normalizeTransitionDuration(auto.durationSeconds),
      maxDur
    );
    out.push(auto);
  }
  return out;
}

/** Largest transition duration that won't eat either adjacent clip. */
function clampForPair(prev: TransitionClip, next: TransitionClip): number {
  const prevDur = Math.max(0.1, prev.end - prev.start);
  const nextDur = Math.max(0.1, next.end - next.start);
  const shorter = Math.min(prevDur, nextDur);
  // Never let a transition exceed ~40% of the shorter neighbour.
  return Math.max(0.05, shorter * 0.4);
}

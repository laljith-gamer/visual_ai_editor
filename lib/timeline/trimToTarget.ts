// =====================================================================
// lib/timeline/trimToTarget.ts
//
// PURE timeline trim-to-target. Drops WHOLE clips until the timeline fits an
// explicit target duration. Two strategies:
//   - "strongest" (default): keep the highest-scoring clips, then restore
//     their original display order.
//   - "order": keep clips in their current order until the budget is hit.
//
// It never partially cuts a clip (that would change content the user picked)
// and it always keeps at least one clip. Used by the store's
// trimTimelineToTarget action (which snapshots for undo) and by the
// "trim to fit" command path. Unit-tested.
// =====================================================================

import type { Highlight } from "@/lib/types";

export type TrimStrategy = "strongest" | "order";

export interface TrimToTargetResult {
  kept: Highlight[];
  removedCount: number;
  totalBefore: number;
  totalAfter: number;
  /** True when the timeline already fit (within tolerance) — nothing removed. */
  alreadyUnder: boolean;
}

function dur(h: Highlight): number {
  return Math.max(0, h.end - h.start);
}

function total(hs: Highlight[]): number {
  return hs.reduce((acc, h) => acc + dur(h), 0);
}

/**
 * Trim `highlights` so their total duration fits `targetSeconds`.
 * `tolerance` (fraction) lets a slightly-over timeline pass untouched
 * (default 5%). Order is preserved in the output for both strategies.
 */
export function trimHighlightsToTarget(
  highlights: Highlight[],
  targetSeconds: number,
  opts: { strategy?: TrimStrategy; tolerance?: number } = {}
): TrimToTargetResult {
  const strategy = opts.strategy ?? "strongest";
  const tolerance = opts.tolerance ?? 0.05;
  const totalBefore = total(highlights);

  if (highlights.length <= 1 || targetSeconds <= 0 || totalBefore <= targetSeconds * (1 + tolerance)) {
    return { kept: highlights, removedCount: 0, totalBefore, totalAfter: totalBefore, alreadyUnder: true };
  }

  // Order to consider clips for KEEPING.
  const order =
    strategy === "strongest"
      ? [...highlights].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      : [...highlights];

  const keptSet = new Set<string>();
  let acc = 0;
  for (const h of order) {
    const d = dur(h);
    if (keptSet.size === 0 || acc + d <= targetSeconds * (1 + tolerance)) {
      keptSet.add(h.id);
      acc += d;
    }
    if (acc >= targetSeconds) break;
  }

  // Restore the ORIGINAL display order among kept clips.
  const kept = highlights.filter((h) => keptSet.has(h.id));
  return {
    kept,
    removedCount: highlights.length - kept.length,
    totalBefore,
    totalAfter: total(kept),
    alreadyUnder: false
  };
}

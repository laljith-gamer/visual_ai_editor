// =====================================================================
// lib/pipeline/selectionFill.ts
//
// Pure "top-up" helper for budgeted highlight selection.
//
// THE BUG IT FIXES: the default `balanced` strategy fills bucket-by-bucket
// with a capped number of rounds and drops any pick that overlaps an
// already-selected clip. When candidates cluster (or overlap), it can stall
// well below the requested length, so an explicit "1 min" lands at ~30s
// (half). After the strategy runs we top up greedily from the remaining
// candidates so the reel actually approaches the user's target when enough
// non-overlapping material exists.
//
// PURE (no imports beyond types) → unit-testable.
// =====================================================================

export interface FillSpan {
  start: number;
  end: number;
  /** Any 0..1 interest score; higher is preferred when topping up. */
  score: number;
}

/** Two spans overlap when they share any time. */
export function spansOverlap(
  a: { start: number; end: number },
  b: { start: number; end: number }
): boolean {
  return a.start < b.end && a.end > b.start;
}

/**
 * Greedily choose the highest-score, non-overlapping spans from `pool` (none
 * of which overlap each other or anything in `occupied`) until the cumulative
 * duration reaches `targetSeconds`. Returns the INDICES into `pool` to add, in
 * pick order. Undershoots only when the pool genuinely runs out of room.
 */
export function pickFillIndices(
  pool: ReadonlyArray<FillSpan>,
  occupied: ReadonlyArray<{ start: number; end: number }>,
  currentTotal: number,
  targetSeconds: number
): number[] {
  const picked: number[] = [];
  if (targetSeconds <= 0) return picked;

  let total = currentTotal;
  const taken: Array<{ start: number; end: number }> = occupied.slice();

  // Score-ranked, keeping the original index so the caller can map back.
  const ranked = pool
    .map((span, index) => ({ span, index }))
    .sort((a, b) => b.span.score - a.span.score);

  for (const { span, index } of ranked) {
    if (total >= targetSeconds) break;
    const dur = span.end - span.start;
    if (dur <= 0) continue;
    if (taken.some((o) => spansOverlap(span, o))) continue;
    picked.push(index);
    taken.push(span);
    total += dur;
  }
  return picked;
}

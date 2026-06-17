/**
 * Phase 3 — placement helpers for the timeline engine.
 *
 * Pure index math for inserting / moving clips in a display-ordered
 * Highlight[]. Kept separate from operations.ts so it can be unit-tested
 * and reused by the orchestrator.
 *
 * GUARDRAIL NOTE: the editor store's `mergeHighlights` re-sorts by
 * (sourceId, start), but `setHighlights` does NOT sort — it stores the
 * array as given. The agent's order-sensitive ops (move / reorder /
 * insert-between / placement) are therefore applied through
 * `setHighlights`, so the explicit order computed here is preserved.
 * Auto plan/merge/promote runs still use `mergeHighlights` (sorted), so
 * an agentic placement onto a sorted timeline can be visually re-grouped
 * by source — the orchestrator surfaces a note when that can happen
 * rather than silently failing.
 */

import type { Highlight } from "@/lib/types";

/** Insert `items` at `index` (clamped) into a copy of `list`. */
export function insertAt(list: Highlight[], items: Highlight[], index: number): Highlight[] {
  const i = clampIndex(index, list.length);
  return [...list.slice(0, i), ...items, ...list.slice(i)];
}

export function appendToEnd(list: Highlight[], items: Highlight[]): Highlight[] {
  return [...list, ...items];
}

export function prependToStart(list: Highlight[], items: Highlight[]): Highlight[] {
  return [...items, ...list];
}

/** Move the clip with `clipId` to `index` (in the order it would occupy
 *  AFTER removal). Returns a new array; no-op if the clip isn't found. */
export function moveClipTo(list: Highlight[], clipId: string, index: number): Highlight[] {
  const from = list.findIndex((h) => h.id === clipId);
  if (from < 0) return list;
  const without = [...list.slice(0, from), ...list.slice(from + 1)];
  const target = clampIndex(index > from ? index - 1 : index, without.length);
  return [...without.slice(0, target), list[from], ...without.slice(target)];
}

export function clampIndex(index: number, length: number): number {
  if (index < 0) return 0;
  if (index > length) return length;
  return index;
}

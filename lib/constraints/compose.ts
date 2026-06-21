// =====================================================================
// lib/constraints/compose.ts
//
// TIMELINE COMPOSER guards for constraint-driven edits.
//
//   - allowGenericFallback(graph): the single gate the selection stage
//     checks before running any "best moments" / offline visual-interest
//     fallback. A constraint-driven graph NEVER permits it.
//   - composeConstrainedTimeline(): final assembly guard. Orders the
//     surviving (already constraint-filtered) highlights per the graph's
//     narrative preference and enforces the duration target WITHOUT ever
//     pulling in new, unfiltered content.
//
// Pure + import-light. Unit-testable with `node --test`.
// =====================================================================

import type { Highlight } from "@/lib/types";
import type { ConstraintGraph } from "./types";
import { isConstraintDriven } from "./graph";

/**
 * Whether a generic best-moments / motion-saliency fallback would be
 * editorially appropriate for this graph.
 *
 *   - Constraint-driven (hard include or any exclude) → false. (Note: the
 *     pipeline no longer needs this as a gate — the hard FRAME filter runs
 *     upstream, so any duration-fill in selection already draws only from
 *     on-constraint candidates. This remains a truthful predicate for
 *     diagnostics, copy, and callers that want to reason about intent.)
 *   - Otherwise → true (the normal "best parts" path the user asked for).
 */
export function allowGenericFallback(
  graph: ConstraintGraph | undefined | null
): boolean {
  if (!graph) return true;
  return !isConstraintDriven(graph);
}

export interface ComposeArgs {
  highlights: Highlight[];
  graph: ConstraintGraph;
  /** Source duration for the (rare) energy/story orderings; optional. */
  videoDuration?: number;
}

/**
 * Assemble the final timeline from constraint-filtered highlights.
 *
 * This NEVER adds content — its inputs are already past the hard gate. It
 * only (a) orders them per the narrative preference and (b) trims to the
 * duration target when the user specified one. Excluded/off-constraint
 * footage cannot appear because it never reached this function.
 */
export function composeConstrainedTimeline(args: ComposeArgs): Highlight[] {
  const { highlights, graph } = args;
  if (highlights.length === 0) return [];

  const ordered = orderByNarrative(highlights, graph);

  // Enforce the duration target only when the user named one.
  if (graph.userSpecifiedDuration && graph.durationSeconds && graph.durationSeconds > 0) {
    return trimToDuration(ordered, graph.durationSeconds);
  }
  return ordered;
}

function orderByNarrative(
  highlights: Highlight[],
  graph: ConstraintGraph
): Highlight[] {
  const list = [...highlights];
  switch (graph.narrative) {
    case "energy":
      // Highest-scoring first (energetic open), preserving the rest by score.
      return list.sort((a, b) => b.score - a.score);
    case "as_is":
      return list;
    case "story_arc":
    case "chronological":
    default:
      // Chronological within a source, grouped by source for stable output.
      return list.sort((a, b) => {
        const sa = a.sourceId ?? "";
        const sb = b.sourceId ?? "";
        if (sa !== sb) return sa.localeCompare(sb);
        return a.start - b.start;
      });
  }
}

/**
 * Trim an ordered highlight list so its total duration does not exceed the
 * target. Whole clips are dropped from the end (after ordering) rather than
 * cutting mid-clip, preserving continuity. Always keeps at least one clip.
 */
function trimToDuration(highlights: Highlight[], targetSeconds: number): Highlight[] {
  const out: Highlight[] = [];
  let total = 0;
  for (const h of highlights) {
    const dur = h.end - h.start;
    if (out.length > 0 && total + dur > targetSeconds) continue;
    out.push(h);
    total += dur;
  }
  return out.length > 0 ? out : [highlights[0]];
}

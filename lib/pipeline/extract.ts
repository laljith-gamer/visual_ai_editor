// =====================================================================
// lib/pipeline/extract.ts — time-bounded slicing.
//
// "first 1 min" / "from 0:30 to 2:00" → return EXACTLY that range.
// No frame sampling, no scoring, no LLM call. O(1).
// =====================================================================

import type { EditPlan, Highlight } from "@/lib/types";
import { newId } from "@/lib/util/id";
import { clamp } from "@/lib/util/time";

export interface ExtractRange {
  /** "first" / "last" / "absolute". For "last", caller resolves start
   *  from videoDuration. */
  kind: "first" | "last" | "absolute";
  startSeconds: number;
  endSeconds: number;
  /** Verbatim user phrasing — kept for activity log. */
  spoken?: string;
}

export interface ExtractInput {
  range: ExtractRange;
  videoDuration: number;
  transition?: EditPlan["transition"];
}

/** Resolve and clamp the range, return one Highlight. Reversed/empty
 *  ranges return []; caller surfaces an error message. */
export function buildExtractedHighlight(input: ExtractInput): Highlight[] {
  const { range, videoDuration } = input;

  let start = range.startSeconds;
  let end = range.endSeconds;

  if (range.kind === "last") {
    const length = Math.max(0, end - start);
    end = videoDuration;
    start = Math.max(0, videoDuration - length);
  }

  start = clamp(start, 0, videoDuration);
  end = clamp(end, 0, videoDuration);

  if (end <= start) return [];

  return [
    {
      id: newId("clip"),
      start: round2(start),
      end: round2(end),
      score: 1.0,
      reason: `Extract ${formatBound(start)} \u2013 ${formatBound(end)}`,
      transition: input.transition ?? "none",
      confidence: "high"
    }
  ];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatBound(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m === 0) return `${s}s`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

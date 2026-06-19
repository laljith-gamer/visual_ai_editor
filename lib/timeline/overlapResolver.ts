// =====================================================================
// lib/timeline/overlapResolver.ts
//
// Detect when an incoming clip overlaps an existing SAME-SOURCE clip and
// help resolve it WITHOUT silently dropping or replacing a meaningful clip
// when intent is unclear. Default for an ambiguous conflict is to ASK the
// user; an explicit user choice (e.g. "keep both") is respected.
//
// PURE: only the centralized OVERLAP thresholds. Unit-tested. The editor
// wires the chosen resolution into the store.
// =====================================================================

import { OVERLAP } from "../config";

export interface OverlapClip {
  id: string;
  sourceId?: string;
  start: number;
  end: number;
}

export interface OverlapConflict {
  incomingClipId: string;
  existingClipId: string;
  sourceId: string;
  overlapSeconds: number;
  overlapRatio: number;
  incomingRange: { start: number; end: number };
  existingRange: { start: number; end: number };
}

export type OverlapResolution = "skip_new" | "replace_existing" | "keep_both" | "trim_new" | "ask_user";

function overlapOf(a: OverlapClip, b: OverlapClip): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/**
 * Find existing same-source clips the incoming clip conflicts with (overlap
 * at/above the configured ratio + minimum). Sub-threshold overlaps are not
 * conflicts — those clips may coexist.
 */
export function detectOverlapConflicts(existing: OverlapClip[], incoming: OverlapClip): OverlapConflict[] {
  const dur = Math.max(0, incoming.end - incoming.start);
  if (dur <= 0) return [];
  const conflicts: OverlapConflict[] = [];
  for (const ex of existing) {
    if (ex.id === incoming.id) continue;
    if ((ex.sourceId ?? null) !== (incoming.sourceId ?? null)) continue;
    const ov = overlapOf(ex, incoming);
    if (ov < OVERLAP.minOverlapSeconds) continue;
    const ratio = ov / dur;
    if (ratio < OVERLAP.conflictRatio) continue;
    conflicts.push({
      incomingClipId: incoming.id,
      existingClipId: ex.id,
      sourceId: incoming.sourceId ?? "",
      overlapSeconds: Math.round(ov * 100) / 100,
      overlapRatio: Math.round(ratio * 100) / 100,
      incomingRange: { start: incoming.start, end: incoming.end },
      existingRange: { start: ex.start, end: ex.end }
    });
  }
  return conflicts;
}

/**
 * Decide the resolution. NEVER returns a destructive resolution on its own —
 * an ambiguous conflict returns "ask_user". An explicit user instruction
 * (keep both / replace / skip / trim) is honored.
 */
export function decideOverlapResolution(
  conflict: OverlapConflict,
  opts: { userExplicit?: Exclude<OverlapResolution, "ask_user"> } = {}
): OverlapResolution {
  if (opts.userExplicit) return opts.userExplicit;
  return "ask_user";
}

function fmt(t: number): string {
  const s = Math.max(0, Math.round(t));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Build the question + option chips for an ambiguous overlap. */
export function buildOverlapQuestion(conflict: OverlapConflict): { message: string; suggestions: string[] } {
  return {
    message: `This new clip overlaps an existing clip from ${fmt(conflict.existingRange.start)} to ${fmt(
      conflict.existingRange.end
    )}. What should I do?`,
    suggestions: ["Skip the new clip", "Replace the old clip", "Keep both", "Trim to non-overlap"]
  };
}

export interface ResolutionResult {
  clips: OverlapClip[];
  applied: OverlapResolution;
  /** Present when the incoming clip was trimmed/dropped — explains it. */
  note?: string;
}

/**
 * Apply a chosen resolution to the existing clip list. Returns the resulting
 * clip list (the editor maps these back into store highlights). "ask_user"
 * makes no change (the caller asks first).
 */
export function applyResolution(
  existing: OverlapClip[],
  incoming: OverlapClip,
  conflict: OverlapConflict,
  resolution: OverlapResolution
): ResolutionResult {
  switch (resolution) {
    case "skip_new":
      return { clips: existing, applied: "skip_new", note: "Kept the existing clip; skipped the new one." };

    case "replace_existing":
      return {
        clips: [...existing.filter((c) => c.id !== conflict.existingClipId), incoming],
        applied: "replace_existing",
        note: "Replaced the overlapping clip with the new one."
      };

    case "keep_both":
      return { clips: [...existing, incoming], applied: "keep_both" };

    case "trim_new": {
      const ex = existing.find((c) => c.id === conflict.existingClipId);
      if (!ex) return { clips: [...existing, incoming], applied: "keep_both" };
      // Keep the larger non-overlapping side of the incoming clip.
      const leftLen = Math.max(0, ex.start - incoming.start);
      const rightLen = Math.max(0, incoming.end - ex.end);
      let trimmed: OverlapClip;
      if (leftLen >= rightLen) trimmed = { ...incoming, start: incoming.start, end: ex.start };
      else trimmed = { ...incoming, start: ex.end, end: incoming.end };
      if (trimmed.end - trimmed.start < OVERLAP.minOverlapSeconds) {
        return { clips: existing, applied: "skip_new", note: "Trimmed clip would be too short — skipped it." };
      }
      return { clips: [...existing, trimmed], applied: "trim_new", note: "Trimmed the new clip to the non-overlapping part." };
    }

    case "ask_user":
    default:
      return { clips: existing, applied: "ask_user" };
  }
}

// =====================================================================
// lib/timeline/overlapFlow.ts
//
// PURE glue between the agent add-clip path and the overlapResolver. It
// detects the first same-source overlap conflict for an incoming add, and
// translates a chosen resolution into concrete add / remove / trim
// instructions over the existing Highlight[] timeline (preserving clip
// metadata). The editor/runner applies the result through the store's
// snapshotting setHighlights/addClips so undo still works.
//
// PURE: imports the resolver (pure) + types only. Unit-tested.
// =====================================================================

import type { Highlight } from "@/lib/types";
import type { NewClipInput } from "./operations";
import {
  applyResolution,
  detectOverlapConflicts,
  type OverlapClip,
  type OverlapConflict,
  type OverlapResolution
} from "./overlapResolver";

const INCOMING_ID = "__incoming__";

export interface AddConflict {
  incoming: NewClipInput;
  conflict: OverlapConflict;
}

function toOverlapClips(highlights: Highlight[]): OverlapClip[] {
  return highlights.map((h) => ({ id: h.id, sourceId: h.sourceId, start: h.start, end: h.end }));
}

/**
 * Detect the FIRST incoming clip that conflicts (same-source overlap at/above
 * the configured ratio) with the existing timeline. Returns null when no
 * incoming clip conflicts — the caller then adds them normally.
 */
export function detectFirstAddConflict(
  current: Highlight[],
  incoming: NewClipInput[]
): AddConflict | null {
  const existing = toOverlapClips(current);
  for (const clip of incoming) {
    const inc: OverlapClip = { id: INCOMING_ID, sourceId: clip.sourceId, start: clip.start, end: clip.end };
    const conflicts = detectOverlapConflicts(existing, inc);
    if (conflicts.length > 0) return { incoming: clip, conflict: conflicts[0] };
  }
  return null;
}

export interface ResolvedAdd {
  /** The clip to add (possibly trimmed), or null when nothing should be added. */
  toAdd: NewClipInput | null;
  /** Existing clip id to remove first (replace), or null. */
  removeExistingId: string | null;
  applied: OverlapResolution;
  note?: string;
}

/**
 * Translate an explicit overlap resolution into add/remove instructions,
 * delegating the geometry (which side to trim, too-short → skip) to the
 * tested applyResolution. NEVER returns a destructive instruction for the
 * "ask_user" sentinel.
 */
export function resolveAddConflict(
  item: AddConflict,
  resolution: Exclude<OverlapResolution, "ask_user">
): ResolvedAdd {
  const inc: OverlapClip = {
    id: INCOMING_ID,
    sourceId: item.incoming.sourceId,
    start: item.incoming.start,
    end: item.incoming.end
  };
  // applyResolution needs the existing clip present to compute trims; rebuild
  // a minimal existing list containing just the conflicting clip.
  const existing: OverlapClip[] = [
    {
      id: item.conflict.existingClipId,
      sourceId: item.incoming.sourceId,
      start: item.conflict.existingRange.start,
      end: item.conflict.existingRange.end
    }
  ];
  const res = applyResolution(existing, inc, item.conflict, resolution);

  if (res.applied === "skip_new") {
    return { toAdd: null, removeExistingId: null, applied: "skip_new", note: res.note };
  }
  if (res.applied === "replace_existing") {
    return {
      toAdd: item.incoming,
      removeExistingId: item.conflict.existingClipId,
      applied: "replace_existing",
      note: res.note
    };
  }
  if (res.applied === "trim_new") {
    const trimmed = res.clips.find((c) => c.id === INCOMING_ID);
    if (!trimmed) return { toAdd: null, removeExistingId: null, applied: "skip_new", note: res.note };
    return {
      toAdd: { ...item.incoming, start: trimmed.start, end: trimmed.end },
      removeExistingId: null,
      applied: "trim_new",
      note: res.note
    };
  }
  // keep_both
  return { toAdd: item.incoming, removeExistingId: null, applied: "keep_both", note: res.note };
}

/**
 * Phase 1 — placement resolution.
 *
 *   - `parsePlacementSpec(text)` — phrasing → unresolved `PlacementSpec`.
 *   - `resolvePlacement(spec, ctx)` — spec → a concrete insertion index
 *     into the timeline (the position a new/moved clip should occupy in
 *     display order).
 *
 * NOTE: the editor store currently keeps the timeline auto-sorted by
 * (sourceId, start). True free re-ordering therefore needs a store change
 * (tracked as a guardrail/TODO). This module resolves the intended index
 * so a future order-preserving store — or an explicit reorder action —
 * can honour it; today the orchestrator uses it for append/prepend and
 * surfaces a note when a precise mid-timeline placement can't be kept.
 */

import { parseClipRef, resolveClip } from "./clipResolver";
import type { AgentCommandContext, PlacementSpec } from "./command";

export function parsePlacementSpec(text: string): PlacementSpec | null {
  if (!text) return null;
  const lower = text.toLowerCase();

  // "between clip 2 and clip 3".
  const between = lower.match(/\bbetween\s+(.+?)\s+and\s+(.+)$/);
  if (between) {
    const first = parseClipRef(`clip ${stripClipWord(between[1])}`) ?? parseClipRef(between[1]);
    const second = parseClipRef(`clip ${stripClipWord(between[2])}`) ?? parseClipRef(between[2]);
    if (first && second) {
      return { kind: "between_clips", first, second, spoken: between[0] };
    }
  }

  // "after clip 2" / "after that".
  const after = lower.match(/\bafter\s+(.+)$/);
  if (after) {
    const clipRef = parseClipRef(after[1]);
    if (clipRef) return { kind: "after_clip", clipRef, spoken: after[0] };
  }

  // "before clip 1" / "before this".
  const before = lower.match(/\bbefore\s+(.+)$/);
  if (before) {
    const clipRef = parseClipRef(before[1]);
    if (clipRef) return { kind: "before_clip", clipRef, spoken: before[0] };
  }

  // "at the start" / "to the front" / "at the beginning".
  if (/\b(?:at\s+the\s+)?(?:start|beginning|front|top)\b/.test(lower) || /\bprepend\b/.test(lower)) {
    return { kind: "at_start", spoken: "at the start" };
  }

  // "at the end" / "to the end" / "append".
  if (/\b(?:at\s+the\s+)?end\b/.test(lower) || /\bappend\b/.test(lower) || /\bafterwards?\b/.test(lower)) {
    return { kind: "at_end", spoken: "at the end" };
  }

  return null;
}

function stripClipWord(s: string): string {
  return s.replace(/\bclips?\b/g, "").trim();
}

export interface PlacementResolution {
  /** 0-based index in display order the clip should be inserted at.
   *  `length` means "append to the end". */
  index: number;
  confidence: number;
  assumptions: string[];
  needsClarification: boolean;
  clarification?: string;
}

export function resolvePlacement(
  spec: PlacementSpec | undefined,
  ctx: AgentCommandContext
): PlacementResolution {
  const n = ctx.highlights.length;
  if (!spec) {
    // Default: append (an "add" never replaces the timeline).
    return { index: n, confidence: 0.9, assumptions: [], needsClarification: false };
  }

  const indexOfClip = (clipId: string | null): number =>
    clipId ? ctx.highlights.findIndex((h) => h.id === clipId) : -1;

  switch (spec.kind) {
    case "at_start":
      return { index: 0, confidence: 0.95, assumptions: [], needsClarification: false };
    case "at_end":
      return { index: n, confidence: 0.95, assumptions: [], needsClarification: false };
    case "after_clip": {
      const r = resolveClip(spec.clipRef, ctx);
      const i = indexOfClip(r.clipId);
      if (i < 0) return clarify("I couldn't find the clip to place after.");
      return { index: i + 1, confidence: 0.88, assumptions: r.assumptions, needsClarification: false };
    }
    case "before_clip": {
      const r = resolveClip(spec.clipRef, ctx);
      const i = indexOfClip(r.clipId);
      if (i < 0) return clarify("I couldn't find the clip to place before.");
      return { index: i, confidence: 0.88, assumptions: r.assumptions, needsClarification: false };
    }
    case "between_clips": {
      const a = indexOfClip(resolveClip(spec.first, ctx).clipId);
      const b = indexOfClip(resolveClip(spec.second, ctx).clipId);
      if (a < 0 || b < 0) return clarify("I couldn't find both clips to place between.");
      return { index: Math.max(a, b), confidence: 0.82, assumptions: [], needsClarification: false };
    }
    default:
      return { index: n, confidence: 0.7, assumptions: [], needsClarification: false };
  }
}

function clarify(message: string): PlacementResolution {
  return { index: -1, confidence: 0.3, assumptions: [], needsClarification: true, clarification: message };
}

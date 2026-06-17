/**
 * Phase 1 — clip resolution.
 *
 *   - `parseClipRef(text)` — pure: phrasing → unresolved `ClipRef`.
 *   - `resolveClip(ref, ctx)` — ref → concrete clip id (+ bounds) using
 *     flow memory (selected clip, last-created clip) when needed.
 *
 * Anaphora ("it" / "that" / "this") parse to a `ClipRef` of kind
 * "anaphora"; resolution prefers the last-created clip, then the
 * selected clip. The orchestrator can override this with richer agent
 * memory, but the deterministic fallback keeps the module usable alone.
 */

import { ORDINAL_TO_INDEX } from "./dictionary";
import { parseSourceRef } from "./sourceResolver";
import type { AgentCommandContext, ClipRef, SourceRef } from "./command";

export function parseClipRef(text: string): ClipRef | null {
  if (!text) return null;
  const lower = text.trim().toLowerCase();

  // "clip 2 from video 1" / "clip 3 in the second video".
  const inSource = lower.match(/\bclip\s+(\d+)\s+(?:from|in|of)\s+(.+)$/);
  if (inSource) {
    const idx = parseInt(inSource[1], 10) - 1;
    const sourceRef = parseSourceRef(inSource[2]);
    if (idx >= 0 && sourceRef) {
      return { kind: "index_in_source", index: idx, sourceRef, spoken: inSource[0] };
    }
  }

  // "clip 2" / "the 2nd clip".
  const num = lower.match(/\bclip\s+(\d+)\b/);
  if (num) {
    const idx = parseInt(num[1], 10) - 1;
    if (idx >= 0) return { kind: "index", index: idx, spoken: num[0] };
  }
  const ord = lower.match(
    /\b(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th)\s+clip\b/
  );
  if (ord) {
    const idx = ORDINAL_TO_INDEX[ord[1]];
    if (idx === 0) return { kind: "first", spoken: ord[0] };
    if (idx != null) return { kind: "index", index: idx, spoken: ord[0] };
  }

  // "first clip" / "last clip".
  if (/\bfirst\s+clip\b/.test(lower)) return { kind: "first", spoken: "first clip" };
  if (/\b(?:last|final)\s+clip\b/.test(lower)) return { kind: "last", spoken: "last clip" };

  // "this clip" / "the selected clip" / "currently selected".
  if (/\b(?:this\s+clip|the\s+selected\s+clip|currently\s+selected|the\s+current\s+clip|selected\s+one)\b/.test(lower)) {
    return { kind: "selected", spoken: "this clip" };
  }

  // "that clip" / "the one you just added" / "the last created clip".
  if (/\b(?:that\s+clip|the\s+clip\s+you\s+just|the\s+(?:last|recently)\s+(?:created|added)\s+clip|the\s+new\s+clip)\b/.test(lower)) {
    return { kind: "last_created", spoken: "that clip" };
  }

  // Bare anaphora: "this" / "that" / "it" (no "clip" word). Lowest
  // precedence — only when used alone-ish so we don't grab "that video".
  if (/^(?:this|that|it)$/.test(lower) || /\b(?:remove|delete|drop|move|cut)\s+(?:this|that|it)\b/.test(lower)) {
    return { kind: "anaphora", spoken: lower };
  }

  return null;
}

export interface ClipResolution {
  clipId: string | null;
  bounds: { start: number; end: number; sourceId?: string } | null;
  confidence: number;
  assumptions: string[];
  needsClarification: boolean;
  clarification?: string;
}

export function resolveClip(ref: ClipRef, ctx: AgentCommandContext): ClipResolution {
  const clips = ctx.highlights;

  const byId = (id: string | null | undefined): ClipResolution => {
    const c = clips.find((h) => h.id === id);
    if (!c) return miss();
    return {
      clipId: c.id,
      bounds: { start: c.start, end: c.end, sourceId: c.sourceId },
      confidence: 0.92,
      assumptions: [],
      needsClarification: false
    };
  };

  switch (ref.kind) {
    case "index":
      return clips[ref.index] ? byId(clips[ref.index].id) : missClarify(`There's no clip ${ref.index + 1} — the timeline has ${clips.length}.`);
    case "index_in_source": {
      const subset = clips.filter((c) => matchesSourceRef(c.sourceId, ref.sourceRef, ctx));
      return subset[ref.index] ? byId(subset[ref.index].id) : missClarify(`I couldn't find that clip in that video.`);
    }
    case "first":
      return clips[0] ? byId(clips[0].id) : miss();
    case "last":
      return clips[clips.length - 1] ? byId(clips[clips.length - 1].id) : miss();
    case "selected":
      return ctx.selectedClipId ? byId(ctx.selectedClipId) : missClarify("No clip is selected. Tap one on the timeline, or say 'clip 2'.");
    case "last_created": {
      const id = ctx.lastCreatedClipIds[ctx.lastCreatedClipIds.length - 1] ?? ctx.selectedClipId;
      const res = byId(id);
      if (res.clipId && id !== ctx.selectedClipId) res.assumptions = ["Using the clip I most recently added."];
      return res;
    }
    case "anaphora": {
      // "it" / "that" — prefer last-created, then selected.
      const id = ctx.lastCreatedClipIds[ctx.lastCreatedClipIds.length - 1] ?? ctx.selectedClipId;
      if (!id) return missClarify("Which clip do you mean?");
      const res = byId(id);
      if (res.clipId) {
        res.confidence = 0.7;
        res.assumptions = [`Assuming you mean ${id === ctx.selectedClipId ? "the selected clip" : "the clip I just added"}.`];
      }
      return res;
    }
    default:
      return miss();
  }
}

function matchesSourceRef(
  sourceId: string | undefined,
  ref: SourceRef,
  ctx: AgentCommandContext
): boolean {
  if (!sourceId) return false;
  // Lightweight: resolve "index" / "active" refs to an id and compare.
  switch (ref.kind) {
    case "index":
      return ctx.sources[ref.index]?.id === sourceId;
    case "active":
      return ctx.activeSourceId === sourceId;
    case "last_used":
      return (ctx.lastUsedSourceId ?? ctx.activeSourceId) === sourceId;
    case "name_hint":
      return ctx.sources.some((s) => s.id === sourceId && s.name.toLowerCase().includes(ref.hint));
    default:
      return false;
  }
}

function miss(): ClipResolution {
  return { clipId: null, bounds: null, confidence: 0, assumptions: [], needsClarification: false };
}

function missClarify(message: string): ClipResolution {
  return { clipId: null, bounds: null, confidence: 0.3, assumptions: [], needsClarification: true, clarification: message };
}

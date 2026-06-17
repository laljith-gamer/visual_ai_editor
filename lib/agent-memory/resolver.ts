/**
 * Phase 2 — memory-driven reference resolution.
 *
 * Resolves anaphora ("it", "that", "this", "same", "again", "another
 * one", "more like this", "after that", "before it") using FlowMemory.
 * The deterministic clip/source resolvers in lib/intent handle explicit
 * references; this layer fills the implicit ones from what the agent has
 * been doing this session.
 */

import type { AgentMemoryStore } from "./store";

export interface AnaphoraSignals {
  /** "it" / "that" / "this" pointing at a clip. */
  clipAnaphora: boolean;
  /** "that video" / "the same one" pointing at a source. */
  sourceAnaphora: boolean;
  /** "same" — reuse the last concept/operation. */
  same: boolean;
  /** "again" / "another one" / "one more" — repeat last operation. */
  again: boolean;
  /** "more like this" / "like clip N" — reinforcement-driven search. */
  moreLikeThis: boolean;
  /** "after that" / "before it" — placement relative to last clip. */
  relativePlacement: "after" | "before" | null;
}

export function detectAnaphora(text: string): AnaphoraSignals {
  const lower = (text ?? "").toLowerCase();
  return {
    clipAnaphora: /\b(?:it|this|that)\b/.test(lower) && !/\b(?:this|that)\s+video\b/.test(lower),
    sourceAnaphora: /\b(?:that\s+video|the\s+same\s+(?:one|video|source)|same\s+source)\b/.test(lower),
    same: /\bsame\b/.test(lower),
    again: /\b(?:again|another\s+one|one\s+more|do\s+it\s+again)\b/.test(lower),
    moreLikeThis: /\bmore\s+like\s+(?:this|that|clip)\b/.test(lower) || /\b(?:like|similar\s+to)\s+clip\s+\d+\b/.test(lower),
    relativePlacement: /\bafter\s+(?:that|it|this)\b/.test(lower)
      ? "after"
      : /\bbefore\s+(?:that|it|this)\b/.test(lower)
        ? "before"
        : null
  };
}

/** Resolve "it"/"that"/"this" → a clip id from flow memory. */
export function resolveAnaphoricClipId(store: AgentMemoryStore): string | null {
  const flow = store.getFlow();
  return (
    flow.lastCreatedClipIds[flow.lastCreatedClipIds.length - 1] ??
    flow.lastSelectedClipId ??
    null
  );
}

/** Resolve "that video"/"the same one" → a source id from flow memory. */
export function resolveAnaphoricSourceId(store: AgentMemoryStore): string | null {
  const flow = store.getFlow();
  return flow.activeSourceId ?? flow.lastMentionedSourceId ?? null;
}

/** Resolve "same"/"again" → the last concept the agent searched for. */
export function resolveAnaphoricConcept(store: AgentMemoryStore): string | null {
  return store.getFlow().lastMentionedConcept ?? null;
}

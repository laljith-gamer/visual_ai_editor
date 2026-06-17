/**
 * Phase 2 — memory observer.
 *
 * Watches the conversation + timeline events and extracts memories into
 * the AgentMemoryStore. Every extracted memory carries a confidence and
 * a one-line `evidence` string. User-stated facts (direct instructions)
 * are stored at high confidence under `kind: "user_stated"`; soft
 * inferences are stored as `observed` at lower confidence — so a direct
 * instruction always outranks an inference downstream.
 *
 * This is deliberately a SMALL, generic extractor — not a per-genre
 * keyword table. It recognises a handful of durable editing intents
 * ("avoid intro", "use only video N", "prefer exact ranges", reinforce
 * a liked/rejected clip) and otherwise records flow state.
 */

import type { AgentMemoryStore } from "./store";

export interface ClipEvent {
  clipId: string;
  sourceId?: string;
  start: number;
  end: number;
}

/** Extract durable user-stated facts + reinforcement from a chat turn. */
export function observeUserMessage(store: AgentMemoryStore, text: string): void {
  const raw = (text ?? "").trim();
  if (!raw) return;
  const lower = raw.toLowerCase();

  // --- avoid intro / outro -----------------------------------------
  if (/\b(?:avoid|skip|no|without|cut)\s+(?:the\s+)?intro\b/.test(lower)) {
    store.remember({
      kind: "user_stated",
      key: "avoid:intro",
      value: true,
      confidence: 0.9,
      evidence: `User said: "${truncate(raw, 60)}"`,
      source: "user"
    });
    store.applyReinforcement({ styleHints: ["avoid intro"] });
  }
  if (/\b(?:avoid|skip|no)\s+(?:the\s+)?(?:outro|ending|credits)\b/.test(lower)) {
    store.remember({
      kind: "user_stated",
      key: "avoid:outro",
      value: true,
      confidence: 0.88,
      evidence: `User said: "${truncate(raw, 60)}"`,
      source: "user"
    });
    store.applyReinforcement({ styleHints: ["avoid outro"] });
  }

  // --- prefer action / less slow -----------------------------------
  if (/\b(?:more\s+action|prefer\s+action|action[\s-]packed|high\s+energy|more\s+energy)\b/.test(lower)) {
    store.remember({
      kind: "preference",
      key: "prefers:action",
      value: true,
      confidence: 0.82,
      evidence: `User asked for more action: "${truncate(raw, 60)}"`,
      source: "user"
    });
    store.applyReinforcement({ styleHints: ["more action"] });
  }
  if (/\b(?:less\s+slow|no\s+slow|skip\s+slow|less\s+talking|cut\s+the\s+slow)\b/.test(lower)) {
    store.applyReinforcement({ styleHints: ["less slow"] });
  }

  // --- exact ranges preference -------------------------------------
  if (/\b(?:exact|precise)\s+(?:start|end|range|times?|timing)\b/.test(lower) || /\bdon'?t\s+(?:trim|change)\s+(?:my|the)\s+(?:range|times?)\b/.test(lower)) {
    store.remember({
      kind: "preference",
      key: "prefers:exact_ranges",
      value: true,
      confidence: 0.85,
      evidence: `User wants exact start/end: "${truncate(raw, 60)}"`,
      source: "user"
    });
  }

  // --- no hardcoded clip count -------------------------------------
  if (/\b(?:no|don'?t|stop)\s+(?:hardcod|fixed|forced|default)\w*\s+(?:clip|count|number|limit|duration)\b/.test(lower) || /\bnot?\s+(?:always|fixed)\s+\d+\s+clips?\b/.test(lower)) {
    store.remember({
      kind: "user_stated",
      key: "no_hardcoded_clip_count",
      value: true,
      confidence: 0.9,
      evidence: `User rejected hardcoded clip behaviour: "${truncate(raw, 60)}"`,
      source: "user"
    });
  }
}

/** A clip was added to the timeline by the agent. */
export function observeClipAdded(store: AgentMemoryStore, clips: ClipEvent[]): void {
  if (clips.length === 0) return;
  store.noteCreatedClips(clips.map((c) => c.clipId));
  const lastSource = clips[clips.length - 1].sourceId;
  if (lastSource) {
    store.setFlow({ activeSourceId: lastSource, lastMentionedSourceId: lastSource });
    bumpSourceUse(store, lastSource);
  }
}

/** A clip was removed (often a negative reinforcement signal). */
export function observeClipRemoved(store: AgentMemoryStore, clip: ClipEvent, byUser = true): void {
  if (!byUser) return;
  store.applyReinforcement({
    rejectedClipIds: [clip.clipId],
    rejectedRanges: [{ sourceId: clip.sourceId, start: clip.start, end: clip.end }]
  });
  store.remember({
    kind: "reinforcement",
    key: `rejected:${clip.clipId}`,
    value: { start: clip.start, end: clip.end },
    confidence: 0.8,
    evidence: "User removed this clip.",
    source: "timeline",
    scope: "clip",
    clipId: clip.clipId,
    sourceId: clip.sourceId
  });
}

/** User selected a clip (flow + weak positive signal). */
export function observeClipSelected(store: AgentMemoryStore, clipId: string | null): void {
  store.setFlow({ lastSelectedClipId: clipId ?? undefined });
}

/** Explicit like / keep ("this is perfect", "keep this type"). */
export function observeClipLiked(store: AgentMemoryStore, clip: ClipEvent): void {
  store.applyReinforcement({
    likedClipIds: [clip.clipId],
    likedRanges: [{ sourceId: clip.sourceId, start: clip.start, end: clip.end }]
  });
  store.remember({
    kind: "reinforcement",
    key: `liked:${clip.clipId}`,
    value: { start: clip.start, end: clip.end },
    confidence: 0.82,
    evidence: "User liked this clip.",
    source: "user",
    scope: "clip",
    clipId: clip.clipId,
    sourceId: clip.sourceId
  });
}

/** User selected a source for use / named it repeatedly. */
export function observeSourceSelected(store: AgentMemoryStore, sourceId: string): void {
  store.setFlow({ activeSourceId: sourceId, lastMentionedSourceId: sourceId });
  bumpSourceUse(store, sourceId);
}

/** User constrained edits to specific source(s) ("use video 1 only"). */
export function observeSourcePreference(
  store: AgentMemoryStore,
  opts: { preferred?: string[]; avoided?: string[]; evidence: string }
): void {
  store.applyReinforcement({ preferredSourceIds: opts.preferred, avoidedSourceIds: opts.avoided });
  if (opts.preferred && opts.preferred.length > 0) {
    store.remember({
      kind: "user_stated",
      key: "source:preferred",
      value: opts.preferred,
      confidence: 0.88,
      evidence: opts.evidence,
      source: "user"
    });
  }
}

export function observeRenderCompleted(store: AgentMemoryStore): void {
  store.setFlow({ lastOperation: "render" });
}

function bumpSourceUse(store: AgentMemoryStore, sourceId: string): void {
  const prev = store.get("source", `use:${sourceId}`);
  const count = typeof prev?.value === "number" ? (prev.value as number) + 1 : 1;
  store.remember({
    kind: "source",
    key: `use:${sourceId}`,
    value: count,
    confidence: Math.min(0.9, 0.5 + count * 0.1),
    evidence: `Used ${count}\u00d7 this session.`,
    source: "agent",
    scope: "source",
    sourceId
  });
}

function truncate(s: string, n: number): string {
  const c = s.replace(/\s+/g, " ").trim();
  return c.length <= n ? c : `${c.slice(0, n - 1)}\u2026`;
}

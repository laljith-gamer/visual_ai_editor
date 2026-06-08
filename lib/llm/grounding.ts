// =====================================================================
// lib/llm/grounding.ts
//
// Turn editor state (briefing best-parts, frame-tree outline, timeline)
// into compact, token-lean TEXT the local model can ground its answers
// on. PURE + deterministic — no model, no I/O.
//
// The headline use case: when the user asks "why are these the best
// parts?", the answer must come from the briefing's stored per-part
// `why` text, not be hallucinated. This module formats that data so the
// chat layer can inject it as grounding context, making such questions
// genuinely answerable instead of dead-ending in a clarify / mis-fired
// action.
// =====================================================================

import type { BestPart } from "@/lib/types";

/** The subset of a briefing this module needs. Structurally satisfied by
 *  the store's `lastBriefing` slot. */
export interface BriefingLike {
  sourceName?: string;
  bestParts: BestPart[];
}

/** Format seconds as M:SS for human-readable, model-friendly timecodes. */
function tc(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Build a grounding block describing the briefing's best parts, including
 * each part's `why`. This is what makes "why are these the best parts"
 * answerable: the model is handed the exact reasons and timecodes.
 *
 * Returns "" when there's nothing to ground on, so callers can append it
 * unconditionally.
 */
export function buildBriefingGrounding(
  briefing: BriefingLike | null | undefined,
  maxParts = 8
): string {
  if (!briefing || !Array.isArray(briefing.bestParts) || briefing.bestParts.length === 0) {
    return "";
  }
  const lines: string[] = [];
  const where = briefing.sourceName ? ` (from "${briefing.sourceName}")` : "";
  lines.push(
    `BRIEFING BEST PARTS${where} — these are the moments already picked, with the reason each was chosen. Answer questions about them using these reasons; do NOT invent new ones:`
  );
  briefing.bestParts.slice(0, maxParts).forEach((p, i) => {
    const span = `${tc(p.startSeconds)}-${tc(p.endSeconds)}`;
    const label = p.label?.trim() || `Part ${i + 1}`;
    const why = p.why?.trim() || "(no stated reason)";
    lines.push(`${i + 1}. [${span}] ${label} — ${why}`);
  });
  return lines.join("\n");
}

/**
 * Compose a full grounding context string from the available editor
 * signals. All parts optional; omitted when empty. Order is most-specific
 * first (briefing reasons) so a small model anchors on the precise data.
 */
export function buildChatGrounding(input: {
  briefing?: BriefingLike | null;
  treeOutline?: string;
  videoDurationSeconds?: number;
  timelineClipCount?: number;
}): string {
  const blocks: string[] = [];

  const briefingBlock = buildBriefingGrounding(input.briefing);
  if (briefingBlock) blocks.push(briefingBlock);

  if (input.treeOutline && input.treeOutline.trim()) {
    blocks.push(`FOOTAGE OUTLINE:\n${input.treeOutline.trim()}`);
  }

  const meta: string[] = [];
  if (typeof input.videoDurationSeconds === "number" && input.videoDurationSeconds > 0) {
    meta.push(`duration ${tc(input.videoDurationSeconds)}`);
  }
  if (typeof input.timelineClipCount === "number") {
    meta.push(`${input.timelineClipCount} clip(s) on the timeline`);
  }
  if (meta.length > 0) blocks.push(`VIDEO: ${meta.join(", ")}.`);

  return blocks.join("\n\n");
}

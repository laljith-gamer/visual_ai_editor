// =====================================================================
// lib/briefing/followups.ts
//
// Normalize briefing follow-ups into structured BriefingFollowUp actions.
//
// The vision model returns follow-ups as plain strings ("Make a reel of
// these moments", "Show all ingredient prep clips"). Plain strings force
// the next turn to re-ask the LLM to guess intent from raw text — which
// is exactly the fragility that produced the "what should the short be
// about?" bug. By normalizing each string into a typed action up-front,
// a tapped chip CARRIES its intent, so the app can route deterministically.
//
// Design rules honored here:
//   - NO genre/keyword tables (no "ingredient" -> "onion/chopping").
//   - The only string inspection is a tiny, bounded check for generic
//     PROMOTE phrasing ("use/clip/reel of THESE/THOSE moments"), which is
//     about referencing the briefing's OWN parts — not about classifying
//     the video's subject. Everything else becomes a plan_topic with the
//     label used verbatim as the scenario. This is safe and generic.
//   - Pure + deterministic. No I/O.
// =====================================================================

import type { BriefingFollowUp } from "@/lib/types";
import { BRIEFING_FOLLOWUP } from "@/lib/config";

/** A briefing shape sufficient to ground follow-up actions. */
export interface FollowUpBriefingContext {
  sourceId: string;
  bestPartIds: string[];
}

/**
 * Detect whether a follow-up label refers to acting on the briefing's
 * EXISTING best parts (promote) rather than finding a new topic.
 *
 * This is intentionally generic and small: it matches an action verb
 * (use/clip/compile/make/turn/add/promote) co-occurring with a
 * back-reference to the briefing's own moments (these/those/them/best
 * parts/moments/highlights/clips). It does NOT classify the video's
 * subject and contains no genre vocabulary, so it generalizes.
 */
export function looksLikePromote(label: string): boolean {
  const s = label.toLowerCase();
  const hasActionVerb = BRIEFING_FOLLOWUP.promoteVerbs.some((v) => s.includes(v));
  const hasBackRef = BRIEFING_FOLLOWUP.promoteBackRefs.some((r) => s.includes(r));
  return hasActionVerb && hasBackRef;
}

/**
 * Normalize a single follow-up (string OR already-structured) into a
 * structured BriefingFollowUp. Already-structured actions pass through
 * (with light validation). Strings are mapped generically:
 *   - generic promote phrasing  -> { kind: "promote" }
 *   - everything else           -> { kind: "plan_topic", scenarioPrompt = label }
 */
export function normalizeFollowUp(
  raw: string | BriefingFollowUp,
  ctx: FollowUpBriefingContext,
  index: number
): BriefingFollowUp {
  // Already structured? Trust it but ensure it has an id/label.
  if (raw && typeof raw === "object") {
    const a = raw as BriefingFollowUp;
    const id = a.id || `fu_${index}`;
    const label = a.label || followUpFallbackLabel(a);
    return { ...a, id, label } as BriefingFollowUp;
  }

  const label = String(raw).trim();
  const id = `fu_${index}`;

  if (looksLikePromote(label)) {
    return {
      id,
      label,
      kind: "promote",
      // No partIds => "all of them"; op append is the safe default.
      op: "append",
      ...(extractTargetSeconds(label) != null
        ? { targetSeconds: extractTargetSeconds(label) as number }
        : {})
    };
  }

  // Default: treat the label as a concrete topic. The scenario prompt is
  // the label verbatim — the planner/pipeline already knows how to score
  // a natural-language scenario, and the editor can also enrich it with
  // briefing context (see synthesizeVaguePlan) on the server side.
  return {
    id,
    label,
    kind: "plan_topic",
    sourceId: ctx.sourceId,
    topic: label,
    scenarioPrompt: label,
    signals: { ...BRIEFING_FOLLOWUP.planTopicSignals }
  };
}

/** Normalize the whole follow-up list. */
export function normalizeFollowUps(
  raw: Array<string | BriefingFollowUp> | undefined,
  ctx: FollowUpBriefingContext
): BriefingFollowUp[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r != null && (typeof r === "string" ? r.trim().length > 0 : true))
    .map((r, i) => normalizeFollowUp(r, ctx, i));
}

/**
 * Convert a structured follow-up back into the plain text the existing
 * chat pipeline understands. Used as the universal fallback path: even
 * when a structured action can't be handled deterministically, we can
 * always send its text through /api/agent exactly like before.
 */
export function followUpToText(a: BriefingFollowUp): string {
  switch (a.kind) {
    case "chat":
      return a.text || a.label;
    case "plan_topic":
      return a.scenarioPrompt || a.topic || a.label;
    case "promote":
    case "extract_range":
    default:
      return a.label;
  }
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

/** Pull an explicit duration like "30s reel" / "60 second" from a label,
 *  bounded to a sane range. Returns null when none stated. Generic. */
function extractTargetSeconds(label: string): number | null {
  const m = label.toLowerCase().match(/(\d{1,3})\s*(?:s|sec|secs|second|seconds)\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n >= 2 && n <= 600) return n;
  }
  const min = label.toLowerCase().match(/(\d{1,2})\s*(?:m|min|mins|minute|minutes)\b/);
  if (min) {
    const n = parseInt(min[1], 10) * 60;
    if (Number.isFinite(n) && n >= 2 && n <= 600) return n;
  }
  return null;
}

function followUpFallbackLabel(a: BriefingFollowUp): string {
  switch (a.kind) {
    case "promote":
      return "Use these moments";
    case "plan_topic":
      return a.topic || "Make a reel";
    case "extract_range":
      return "Grab that range";
    case "chat":
      return a.text || "Tell me more";
    default:
      return "Next";
  }
}

/**
 * Phase 7 — reinforcement.
 *
 * Two parts:
 *   - `detectReinforcement(text, ctx)` — recognise feedback phrases
 *     ("not this", "more like clip 2", "use video 1 only", "this is
 *     perfect", "avoid intro") and turn them into a reinforcement memory
 *     patch + the positive/negative references they imply.
 *   - `adjustScore(base, candidate, rf)` — apply accumulated
 *     reinforcement to a candidate range's score: penalize ranges that
 *     overlap rejected ones, boost ranges near liked ones, boost/penalize
 *     by preferred/avoided source, and nudge for style hints
 *     ("more action" / "less slow") when motion is known.
 *
 * Kept simple per the spec: overlap penalty for rejected ranges, source
 * boost/penalty, concept boost/penalty, motion adjustment.
 */

import type { ReinforcementMemory } from "@/lib/agent-memory/types";
import type { AgentCommandContext, ClipRef } from "@/lib/intent/command";
import { parseClipRef, resolveClip } from "@/lib/intent/clipResolver";

export interface ReinforcementSignal {
  /** True when the turn carried any reinforcement at all. */
  isReinforcement: boolean;
  /** Patch to merge into agent reinforcement memory. */
  patch: Partial<ReinforcementMemory>;
  /** Mark the currently-selected clip as rejected ("not this"). */
  rejectSelected: boolean;
  /** Mark the currently-selected clip as liked ("this is perfect"). */
  likeSelected: boolean;
  /** A positive reference clip ("more like clip 2"). */
  positiveClipRef: ClipRef | null;
  /** True when the user wants a NEW search informed by the feedback
   *  ("more like this", "not this, find another"). */
  wantsResearch: boolean;
  /** Short confirmation message for chat. */
  message: string;
}

export function detectReinforcement(text: string, ctx: AgentCommandContext): ReinforcementSignal {
  const lower = (text ?? "").toLowerCase();
  const sig: ReinforcementSignal = {
    isReinforcement: false,
    patch: {},
    rejectSelected: false,
    likeSelected: false,
    positiveClipRef: null,
    wantsResearch: false,
    message: ""
  };

  // --- negative: "not this", "wrong part", "avoid this" --------------
  if (/\b(?:not\s+this|wrong\s+(?:part|clip|one)|avoid\s+this|not\s+(?:that|it)|don'?t\s+like\s+this|that'?s\s+not\s+(?:it|right))\b/.test(lower)) {
    sig.isReinforcement = true;
    sig.rejectSelected = true;
    sig.wantsResearch = true;
    sig.message = "Got it — I'll avoid that and look for a better fit.";
  }

  // --- positive: "more like clip 2" / "more like this" ---------------
  const moreLikeClip = lower.match(/\b(?:more\s+like|similar\s+to|like)\s+(clip\s+\d+|the\s+\w+\s+clip)\b/);
  if (moreLikeClip) {
    const ref = parseClipRef(moreLikeClip[1]);
    if (ref) {
      sig.isReinforcement = true;
      sig.positiveClipRef = ref;
      sig.wantsResearch = true;
      const r = resolveClip(ref, ctx);
      if (r.clipId) {
        sig.patch.likedClipIds = [r.clipId];
        if (r.bounds) sig.patch.likedRanges = [{ sourceId: r.bounds.sourceId, start: r.bounds.start, end: r.bounds.end }];
      }
      sig.message = "Understood — I'll find more moments like that one.";
    }
  } else if (/\bmore\s+like\s+(?:this|that|it)\b/.test(lower)) {
    sig.isReinforcement = true;
    sig.wantsResearch = true;
    if (ctx.selectedClipId) {
      sig.patch.likedClipIds = [ctx.selectedClipId];
      const sel = ctx.highlights.find((h) => h.id === ctx.selectedClipId);
      if (sel) sig.patch.likedRanges = [{ sourceId: sel.sourceId, start: sel.start, end: sel.end }];
    }
    sig.message = "Understood — I'll find more like this.";
  }

  // --- "this is perfect" / "keep this type" --------------------------
  if (/\b(?:this\s+is\s+(?:perfect|great|good)|keep\s+this\s+type|love\s+this|exactly|nailed\s+it)\b/.test(lower)) {
    sig.isReinforcement = true;
    sig.likeSelected = true;
    if (!sig.message) sig.message = "Great — I'll keep this style.";
  }

  // --- source preference: "use video 1 only" / "don't use this video"
  const onlyVideo = lower.match(/\buse\s+(?:video|source)\s+(\d+)\s+(?:only|alone)\b/) || lower.match(/\bonly\s+(?:use\s+)?(?:video|source)\s+(\d+)\b/);
  if (onlyVideo) {
    const idx = parseInt(onlyVideo[1], 10) - 1;
    const src = ctx.sources[idx];
    if (src) {
      sig.isReinforcement = true;
      sig.patch.preferredSourceIds = [src.id];
      sig.patch.avoidedSourceIds = ctx.sources.filter((_, i) => i !== idx).map((s) => s.id);
      sig.message = `Okay — I'll only pull from "${src.name}".`;
    }
  }
  if (/\b(?:don'?t|do\s+not|stop)\s+us(?:e|ing)\s+(?:this|that)\s+video\b/.test(lower)) {
    const avoid = ctx.activeSourceId ?? ctx.lastUsedSourceId;
    if (avoid) {
      sig.isReinforcement = true;
      sig.patch.avoidedSourceIds = [avoid];
      const name = ctx.sources.find((s) => s.id === avoid)?.name ?? "that video";
      sig.message = `Got it — I'll skip "${name}".`;
    }
  }

  // --- style hints: avoid intro / more action ------------------------
  if (/\b(?:avoid|skip|no|cut)\s+(?:the\s+)?intro\b/.test(lower)) {
    sig.isReinforcement = true;
    sig.patch.styleHints = ["avoid intro"];
    if (!sig.message) sig.message = "I'll avoid the intro.";
  }
  if (/\bmore\s+action\b/.test(lower)) {
    sig.isReinforcement = true;
    sig.patch.styleHints = [...(sig.patch.styleHints ?? []), "more action"];
    if (!sig.message) sig.message = "I'll favour higher-action moments.";
  }
  if (/\b(?:less\s+slow|fewer\s+slow|no\s+slow)\b/.test(lower)) {
    sig.isReinforcement = true;
    sig.patch.styleHints = [...(sig.patch.styleHints ?? []), "less slow"];
  }

  return sig;
}

// ---------------------------------------------------------------------
// Scoring adjustment
// ---------------------------------------------------------------------

export interface ScoreCandidate {
  sourceId?: string;
  start: number;
  end: number;
  /** Optional motion signal (0..1) so "more action" / "less slow" can
   *  nudge the score when known. */
  motion?: number;
  /** Optional concept/label this candidate carries. */
  concept?: string;
}

/**
 * Adjust a base score (0..1) using accumulated reinforcement. Returns a
 * clamped score. Pure — easy to unit-test.
 */
export function adjustScore(base: number, candidate: ScoreCandidate, rf: ReinforcementMemory): number {
  let score = base;

  // Rejected-range overlap penalty (strong).
  for (const r of rf.rejectedRanges) {
    if (sameSource(r.sourceId, candidate.sourceId) && overlaps(r, candidate)) {
      score -= 0.4;
    }
  }
  // Liked-range proximity boost.
  for (const r of rf.likedRanges) {
    if (sameSource(r.sourceId, candidate.sourceId) && overlaps(r, candidate)) {
      score += 0.2;
    }
  }
  // Source preference.
  if (candidate.sourceId) {
    if (rf.avoidedSourceIds.includes(candidate.sourceId)) score -= 0.5;
    if (rf.preferredSourceIds.includes(candidate.sourceId)) score += 0.1;
  }
  // Concept preference.
  if (candidate.concept) {
    const c = candidate.concept.toLowerCase();
    if (rf.rejectedConcepts.some((x) => c.includes(x.toLowerCase()))) score -= 0.25;
    if (rf.likedConcepts.some((x) => c.includes(x.toLowerCase()))) score += 0.15;
  }
  // Motion-driven style hints.
  if (typeof candidate.motion === "number") {
    if (rf.styleHints.includes("more action")) score += (candidate.motion - 0.5) * 0.3;
    if (rf.styleHints.includes("less slow")) score += (candidate.motion - 0.5) * 0.2;
  }

  return Math.max(0, Math.min(1, score));
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && a.end > b.start;
}
function sameSource(a?: string, b?: string): boolean {
  // Treat "no source" as wildcard so single-video sessions still match.
  if (!a || !b) return true;
  return a === b;
}

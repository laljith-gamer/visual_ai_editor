/**
 * v1.7.5 — Promote intent matcher (briefing → timeline clips).
 *
 * Triggers: "clip those", "use the briefing", "lift the second one",
 * "make a 30s reel of these".
 *
 * Hard preconditions:
 *   - state.lastBriefing exists and has at least one bestPart.
 *   - The user message references those parts (verb + target).
 *
 * Confidence model:
 *   - 0.90 when (PROMOTE_VERBS verb) AND (PROMOTE_TARGETS target)
 *   - 0.92 when ordinal-based subset is resolved unambiguously
 *   - threshold 0.85 at the orchestrator
 */

import { PROMOTE_VERBS, PROMOTE_TARGETS } from "../dictionary";
import {
  hasNegation,
  hasPhrase,
  hasVerbLemma,
  type ParsedText
} from "../grammar";
import { resolveBriefingPartsReference, resolveOp } from "../slots";
import { parseDuration } from "../time";
import type { QuickMatchContext, QuickMatchPromote } from "../types";

export function matchPromote(
  p: ParsedText,
  ctx: QuickMatchContext
): QuickMatchPromote | null {
  if (hasNegation(p)) return null;
  if (!ctx.lastBriefing || ctx.lastBriefing.bestParts.length === 0) return null;

  const verbMatch = hasVerbLemma(p, PROMOTE_VERBS);
  const targetMatch = hasPhrase(p, PROMOTE_TARGETS);
  if (!verbMatch || !targetMatch) return null;

  const partsRef = resolveBriefingPartsReference(p.lower, ctx);
  if (partsRef.scope === "none") return null;

  // "make a 30s reel of these" — extract the optional duration.
  let targetSeconds: number | undefined;
  const reelMatch = p.lower.match(
    /(?:make|build|create|cut)\s+(?:a\s+)?(.+?)\s+(?:reel|short|edit|cut|version)/
  );
  if (reelMatch) {
    const dur = parseDuration(reelMatch[1]);
    if (dur != null && dur > 0) targetSeconds = dur;
  }

  const op = resolveOp(p.lower);

  let confidence = 0.9;
  if (partsRef.scope === "subset") confidence = 0.92;

  return {
    kind: "promote",
    confidence: Math.min(1, confidence),
    patternId: `promote.${partsRef.scope}`,
    matchedText: p.raw,
    partIds:
      partsRef.scope === "subset" && partsRef.partIds.length > 0
        ? partsRef.partIds
        : undefined,
    targetSeconds,
    op
  };
}

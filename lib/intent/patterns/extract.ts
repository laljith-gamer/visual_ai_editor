/**
 * v1.7.5 — Extract intent matcher.
 *
 * Triggers: "first 30 seconds", "last 10s", "from 0:30 to 1:45",
 * "give me the first minute".
 *
 * Confidence model:
 *   - base 0.85 when a clean range is parsed (the strongest signal).
 *     A bare timestamp without "first" / "last" / "to" doesn't fire —
 *     too ambiguous; cloud planner handles those.
 *   - +0.08 when an EXTRACT_VERBS verb is present ("give me", "take",
 *     "grab"). Optional but boosts confidence for pure imperatives.
 *   - +0.05 when source reference is present.
 */

import { EXTRACT_VERBS } from "../dictionary";
import { hasNegation, hasVerbLemma, type ParsedText } from "../grammar";
import { resolveSourceReference } from "../slots";
import { parseRange } from "../time";
import type { QuickMatchContext, QuickMatchExtract } from "../types";

export function matchExtract(
  p: ParsedText,
  ctx: QuickMatchContext
): QuickMatchExtract | null {
  if (hasNegation(p)) return null;
  if (ctx.sources.length === 0) return null;

  const range = parseRange(p.lower);
  if (!range) return null;

  let confidence = 0.85; // clean range parse is the strong signal

  if (hasVerbLemma(p, EXTRACT_VERBS)) confidence += 0.08;

  const sourceRef = resolveSourceReference(p.lower, ctx);
  const sourceId =
    sourceRef.sourceIds.length === 1 ? sourceRef.sourceIds[0] : undefined;
  if (sourceId) confidence += 0.05;

  return {
    kind: "extract",
    confidence: Math.min(1, confidence),
    patternId: `extract.${range.kind}`,
    matchedText: p.raw,
    range: {
      kind: range.kind,
      startSeconds: range.startSeconds,
      endSeconds: range.endSeconds,
      spoken: range.spoken
    },
    sourceId
  };
}

/**
 * v1.7.5 — Merge intent matcher.
 *
 * Triggers: "merge the videos", "join them", "stitch the clips",
 * "concatenate", "no edit just merge", "use the full videos".
 *
 * Confidence model:
 *   - base 0.70 when (verb in MERGE_VERBS) AND (noun/pronoun target found)
 *   - +0.15 when an "as-is" modifier appears ("whole", "no edit", ...)
 *   - +0.10 when "just <verb>" appears (strong signal of merge intent)
 *   - +0.05 when a quantifier appears ("all the", "both", "every")
 *   - threshold gate at 0.85 (orchestrator-level)
 */

import {
  MERGE_VERBS,
  MERGE_OBJECTS,
  MERGE_AS_IS_MODIFIERS
} from "../dictionary";
import {
  hasNegation,
  hasNoun,
  hasPhrase,
  hasVerbLemma,
  type ParsedText
} from "../grammar";
import {
  resolveOp,
  resolveSourceReference,
  resolveTransition
} from "../slots";
import type { QuickMatchContext, QuickMatchMerge } from "../types";

/** Merge can fire with as few as 1 source — concatenating one full
 *  video onto the timeline is a valid no-edit pass-through. */
const MIN_SOURCES = 1;

export function matchMerge(
  p: ParsedText,
  ctx: QuickMatchContext
): QuickMatchMerge | null {
  if (hasNegation(p)) return null;
  if (ctx.sources.length < MIN_SOURCES) return null;

  const hasVerb = hasVerbLemma(p, MERGE_VERBS);
  if (!hasVerb) return null;

  const hasObject = hasNoun(p, MERGE_OBJECTS);
  if (!hasObject) return null;

  // Base score for the (verb + object) combo.
  let confidence = 0.7;

  // "as is" / "whole" / "no edit" — explicit "don't be clever" signal.
  if (hasPhrase(p, MERGE_AS_IS_MODIFIERS)) {
    confidence += 0.15;
  }

  // "just <verb>" — common phrasing that strongly disambiguates from
  // editorial intent.
  if (/\bjust\s+(merge|join|stitch|concat|combine|glue)/.test(p.lower)) {
    confidence += 0.1;
  }

  // Quantifiers that confirm "all of them, in order".
  if (
    /\ball\s+(?:the\s+)?(videos|clips|sources)\b/.test(p.lower) ||
    /\bboth\s+(videos|clips|sources)?\b/.test(p.lower) ||
    /\bevery\s+(video|clip|source)\b/.test(p.lower)
  ) {
    confidence += 0.05;
  }

  // Resolve slots
  const transition = resolveTransition(p.lower);
  const op = resolveOp(p.lower);
  const sourceRef = resolveSourceReference(p.lower, ctx);

  return {
    kind: "merge",
    confidence: Math.min(1, confidence),
    patternId: "merge.basic",
    matchedText: p.raw,
    sourceIds:
      sourceRef.sourceIds.length > 0 ? sourceRef.sourceIds : undefined,
    transition,
    op
  };
}

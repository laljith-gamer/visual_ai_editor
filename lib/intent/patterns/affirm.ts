/**
 * v1.7.5 — Affirmation matcher.
 *
 * Catches short "yes / go / do it" replies when there's a pending
 * action (clarify question or plan-preview) waiting on the user. The
 * caller dispatches the pending action; no slots needed.
 *
 * Hard preconditions:
 *   - ctx.pendingExecution is true (plan-preview waiting on confirm).
 *     We deliberately DON'T fire on ctx.pendingClarify — affirming a
 *     clarify question requires the cloud planner to interpret what
 *     "yes" means in that question's context.
 *   - The user message is short (≤ 4 tokens) — anything longer might
 *     carry secondary intent ("yes but actually trim it first") and
 *     should go through the cloud planner.
 *   - The leading token is one of AFFIRM_TOKENS, OR the entire
 *     message is one of AFFIRM_TOKENS (multi-word phrases).
 *
 * Confidence: 0.92 when both checks pass. Single rule; no tuning.
 */

import { AFFIRM_TOKENS } from "../dictionary";
import {
  hasNegation,
  isShortUtterance,
  type ParsedText
} from "../grammar";
import type { QuickMatchAffirm, QuickMatchContext } from "../types";

export function matchAffirm(
  p: ParsedText,
  ctx: QuickMatchContext
): QuickMatchAffirm | null {
  if (!ctx.pendingExecution) return null;
  if (!isShortUtterance(p, 4)) return null;
  if (hasNegation(p)) return null;

  // "but" / "actually" / "wait" disqualifies — user is qualifying the
  // affirmation, not pure-affirming.
  if (/\b(but|actually|wait|hold on|hmm|maybe|though)\b/.test(p.lower)) {
    return null;
  }

  const lower = p.lower;
  const isAffirm =
    AFFIRM_TOKENS.some((t) => lower === t) ||
    AFFIRM_TOKENS.some((t) => lower.startsWith(t + " ")) ||
    AFFIRM_TOKENS.some((t) => lower.endsWith(" " + t));

  if (!isAffirm) return null;

  return {
    kind: "affirm",
    confidence: 0.92,
    patternId: "affirm.basic",
    matchedText: p.raw
  };
}

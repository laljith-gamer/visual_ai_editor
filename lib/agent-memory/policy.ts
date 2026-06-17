/**
 * Phase 2 — confidence policy.
 *
 * Maps a resolved-command confidence to one of three actions:
 *   - execute            (high confidence)
 *   - execute_with_note  (medium — do it, but state the assumption)
 *   - clarify            (low — ask a short question first)
 *
 * Thresholds live in `lib/config.ts` (AGENT_POLICY) so they're tunable
 * in one place per the project's "no magic numbers" rule.
 */

import { AGENT_POLICY } from "../config";

export type PolicyDecision = "execute" | "execute_with_note" | "clarify";

export function decideAction(confidence: number): PolicyDecision {
  if (confidence >= AGENT_POLICY.executeThreshold) return "execute";
  if (confidence >= AGENT_POLICY.noteThreshold) return "execute_with_note";
  return "clarify";
}

/** Combine several resolver confidences into one. Uses the MINIMUM (the
 *  weakest link) plus a small penalty per additional uncertain part, so
 *  a command that needed three shaky resolutions is treated cautiously. */
export function combineConfidence(parts: number[]): number {
  const present = parts.filter((p) => p > 0);
  if (present.length === 0) return 0;
  const min = Math.min(...present);
  const uncertain = present.filter((p) => p < AGENT_POLICY.executeThreshold).length;
  const penalty = Math.max(0, uncertain - 1) * 0.05;
  return Math.max(0, Math.min(1, min - penalty));
}

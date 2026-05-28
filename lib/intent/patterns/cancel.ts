/**
 * v1.7.5 — Cancel matcher.
 *
 * Catches "cancel" / "never mind" / "forget it" / "stop". When a
 * pending action exists (clarify or plan-preview), this clears it and
 * acknowledges. Otherwise it falls through to the cloud planner — the
 * user might be cancelling the previous render, which is a more
 * complex flow we don't try to model client-side.
 *
 * Confidence: 0.92, same reasoning as affirm.
 */

import { CANCEL_TOKENS } from "../dictionary";
import { isShortUtterance, type ParsedText } from "../grammar";
import type { QuickMatchCancel, QuickMatchContext } from "../types";

export function matchCancel(
  p: ParsedText,
  ctx: QuickMatchContext
): QuickMatchCancel | null {
  // Only fire when there's something to cancel — otherwise the cloud
  // planner can interpret broader cancel-style intents (undo render,
  // restart session, etc.).
  if (!ctx.pendingExecution && !ctx.pendingClarify) return null;
  if (!isShortUtterance(p, 5)) return null;

  const lower = p.lower;
  const isCancel =
    CANCEL_TOKENS.some((t) => lower === t) ||
    CANCEL_TOKENS.some((t) => lower.startsWith(t + " ")) ||
    CANCEL_TOKENS.some((t) => lower.endsWith(" " + t));

  if (!isCancel) return null;

  return {
    kind: "cancel",
    confidence: 0.92,
    patternId: "cancel.basic",
    matchedText: p.raw
  };
}

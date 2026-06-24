// =====================================================================
// lib/plan/applyRememberedTarget.ts
//
// Conversation-memory bridge for the TARGET DURATION.
//
// The store tracks the active target duration across turns ("…for 1 min"
// stays in effect until the user changes it). But a later turn that only
// names a SUBJECT ("combat scene on this") produces a plan with no duration
// (userSpecifiedDuration=false). On that path the selector falls back to the
// generic no-budget quality floor (capped at maxTotalSecondsWithoutBudget)
// and never fills toward the user's real target — so "1 min" silently became
// ~30s in the reported transcript.
//
// This pure helper re-applies the remembered target to such a plan so the
// budgeted selection path (which fills toward targetShortSeconds) runs. It is
// CONSERVATIVE: it only fills in a MISSING constraint and never overrides a
// duration the current plan already set explicitly.
//
// PURE: no store, no React, no network. Unit-tested.
// =====================================================================

import type { EditPlan } from "@/lib/types";

/**
 * Return a plan that honours the remembered active target when the plan
 * itself didn't capture an explicit duration.
 *
 * @param plan                 the freshly built plan for this turn
 * @param activeTargetSeconds  the remembered active target (store), or null
 */
export function applyRememberedTarget(
  plan: EditPlan,
  activeTargetSeconds: number | null | undefined
): EditPlan {
  // Nothing remembered, or the current plan already states a duration → leave
  // the plan exactly as-is (latest explicit intent always wins).
  if (typeof activeTargetSeconds !== "number" || !Number.isFinite(activeTargetSeconds)) {
    return plan;
  }
  if (activeTargetSeconds <= 0) return plan;
  if (plan.userSpecifiedDuration === true) return plan;

  return {
    ...plan,
    targetShortSeconds: activeTargetSeconds,
    userSpecifiedDuration: true
  };
}

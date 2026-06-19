// =====================================================================
// lib/agentic-intake/runIntake.ts
//
// Thin CLIENT adapter that bridges the PURE intake orchestrator
// (intake.ts) to the editor store. It snapshots the live store for
// context, keeps a per-session partial EditBrief so the brief can be
// built across multiple turns, and returns the IntakeOutcome for the
// editor to act on.
//
// This is the ONLY store-aware piece of the intake layer. Everything it
// calls (planIntake → inferBrief / questionEngine / promptCompiler /
// routeDecision) is pure + unit-tested. It is lazy-imported by the editor
// so its (tiny) weight stays out of the initial bundle.
// =====================================================================

import { useEditorStore } from "@/hooks/useEditorStore";
import { planIntake, type IntakeContext, type IntakeOutcome } from "./intake";
import type { EditBrief } from "./editBrief";

/** Per-session partial brief, so vague requests can be completed over
 *  several turns ("make this cool" → "Best-moments reel" → "30s"). */
const briefBySession = new Map<string, EditBrief>();

export interface RunIntakeOptions {
  /** A cloud planner/vision endpoint is reachable. */
  cloudAvailable: boolean;
  /** An on-device text planner is usable. */
  localPlannerAvailable: boolean;
  /** Cloud frame-vision is available (for describe routing). */
  cloudVisionAvailable?: boolean;
}

/**
 * Run the agentic intake layer for one user turn. Reads the live store
 * for context, merges with the session's prior brief, and returns the
 * outcome. The merged brief is persisted for the next turn.
 */
export function runIntake(userText: string, opts: RunIntakeOptions): IntakeOutcome {
  const s = useEditorStore.getState();

  const ctx: IntakeContext = {
    libraryCount: s.sources.length,
    selectedCount: s.selectedSourceIds.length,
    timelineClipCount: s.highlights.length,
    hasActiveSource: Boolean(s.activeSourceId),
    cloudAvailable: opts.cloudAvailable,
    localPlannerAvailable: opts.localPlannerAvailable,
    cloudVisionAvailable: opts.cloudVisionAvailable,
    // Once a plan is queued/active, refinement is the existing flow's job —
    // intake must NOT intercept (no second clarify UI, no double planning).
    hasActivePlan: Boolean(s.plan) || s.pendingExecution
  };

  const prior = briefBySession.get(s.sessionId) ?? null;
  const outcome = planIntake(userText, ctx, prior);

  // Persist the merged brief for the next turn. A new session uses a fresh
  // sessionId, so this map never leaks intent across sessions.
  briefBySession.set(s.sessionId, outcome.brief);

  return outcome;
}

/** Drop a session's accumulated brief (e.g. on explicit reset). */
export function clearIntakeBrief(sessionId: string): void {
  briefBySession.delete(sessionId);
}

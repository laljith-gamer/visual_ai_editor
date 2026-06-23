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
import { createEmptyBrief, type EditBrief } from "./editBrief";
import type { BriefPatch } from "./pendingAnswerResolver";

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

/**
 * Merge a resolved pending-answer PATCH into the session's persisted brief.
 *
 * This is the fix for the "Which video should I use?" loop: when the user
 * answers a clarify question, the resolver produces a BriefPatch (e.g.
 * source_scope = "all"). Without applying it to the persisted brief, the
 * follow-up runIntake() would re-infer only from the bare answer word
 * ("both"/"all"), find no scope, and re-ask the SAME question forever.
 *
 * Call this with the resolved patch BEFORE re-running runIntake, so the next
 * planIntake merges the now-known field instead of losing it. PURE w.r.t. the
 * patch shape — only the session store id is read.
 */
export function applyAnswerToSessionBrief(patch: BriefPatch): void {
  const s = useEditorStore.getState();
  const prior = briefBySession.get(s.sessionId) ?? createEmptyBrief();
  const merged: EditBrief = {
    ...prior,
    intentKind: patch.intentKind ?? prior.intentKind,
    sourceScope: patch.sourceScope
      ? {
          type: patch.sourceScope.type as EditBrief["sourceScope"]["type"],
          reason: patch.sourceScope.reason ?? prior.sourceScope.reason
        }
      : prior.sourceScope,
    output: { ...prior.output, ...(patch.output ?? {}) },
    content: { ...prior.content, ...(patch.content ?? {}) }
  };
  // Lock the resolved field's confidence high so finalizeBrief can't override
  // it back to a default on the next turn.
  if (patch.sourceScope) {
    merged.confidence = {
      ...merged.confidence,
      sourceScope: Math.max(merged.confidence.sourceScope, 0.9)
    };
  }
  briefBySession.set(s.sessionId, merged);
}

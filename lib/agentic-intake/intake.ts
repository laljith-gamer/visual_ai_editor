// =====================================================================
// lib/agentic-intake/intake.ts
//
// The Agentic Intake Router — the pure orchestration that sits BEFORE the
// existing planner. It does NOT replace the planner; it improves the input
// sent to it.
//
//   user message(s) → inferBrief → mergeBrief (multi-turn) → finalize
//                   → questionEngine → routeDecision → outcome
//
// Outcomes:
//   - "clarify"     : ask ONE option-chip question (reuse pendingClarify).
//   - "proceed"     : enough info — emit a clean compiled prompt + summary.
//   - "passthrough" : let the existing flow handle it (vision/fast command/
//                     refinement) — intake stays out of the way.
//
// PURE: no React, no store. The client adapter (runIntake.ts) feeds it
// context from the store and applies the outcome.
// =====================================================================

import type { ClarifyQuestion } from "@/lib/types";
import { inferBrief, finalizeBrief, type InferContext } from "./inferBrief";
import { mergeBrief, type EditBrief } from "./editBrief";
import { decideQuestion } from "./questionEngine";
import { decideRoute, type RouteContext, type RouteResult } from "./routeDecision";
import { compileBriefPrompt, briefSummaryMessage } from "./promptCompiler";

export interface IntakeContext extends InferContext {
  cloudAvailable: boolean;
  localPlannerAvailable: boolean;
  cloudVisionAvailable?: boolean;
  /** A plan is already queued / refining — intake should NOT intercept. */
  hasActivePlan?: boolean;
}

export type IntakeOutcome =
  | {
      kind: "clarify";
      brief: EditBrief;
      message: string;
      question: ClarifyQuestion;
      route: RouteResult;
    }
  | {
      kind: "proceed";
      brief: EditBrief;
      /** Clean, structured planner-facing prompt (never raw user text). */
      compiledPrompt: string;
      /** Friendly human-facing confirmation. */
      summary: string;
      route: RouteResult;
    }
  | {
      kind: "passthrough";
      brief: EditBrief;
      reason: string;
      route: RouteResult;
    };

/** Intents the intake layer actively shepherds (asks questions / compiles).
 *  Everything else passes straight through to the existing flow. */
const CREATION_INTENTS = new Set<EditBrief["intentKind"]>([
  "create_short",
  "highlight_reel",
  "continuous_clip",
  "specific_moment",
  "extract_range",
  "merge_sources",
  "compose_montage",
  "unknown"
]);

/**
 * Build a brief from the new message merged with an optional prior brief,
 * then decide the outcome. Stateless — the caller owns brief persistence.
 */
export function planIntake(
  userText: string,
  ctx: IntakeContext,
  priorBrief?: EditBrief | null
): IntakeOutcome {
  const inferCtx: InferContext = {
    libraryCount: ctx.libraryCount,
    selectedCount: ctx.selectedCount,
    timelineClipCount: ctx.timelineClipCount,
    hasActiveSource: ctx.hasActiveSource
  };

  const fresh = inferBrief(userText, inferCtx);
  const brief = priorBrief
    ? finalizeBrief(mergeBrief(priorBrief, fresh), inferCtx)
    : fresh;

  const routeCtx: RouteContext = {
    cloudAvailable: ctx.cloudAvailable,
    localPlannerAvailable: ctx.localPlannerAvailable,
    cloudVisionAvailable: ctx.cloudVisionAvailable,
    willAsk: false // decided below
  };

  // Vision / fast-command / refinement intents are NOT shepherded here.
  if (
    brief.intentKind === "describe_video" ||
    brief.intentKind === "export_render" ||
    brief.intentKind === "style_existing_timeline" ||
    brief.intentKind === "fix_existing_edit" ||
    ctx.hasActivePlan
  ) {
    return {
      kind: "passthrough",
      brief,
      reason:
        ctx.hasActivePlan
          ? "a plan is already active — let the existing refinement path handle it"
          : `intent ${brief.intentKind} is handled by the existing flow`,
      route: decideRoute(brief, routeCtx)
    };
  }

  // Only creation intents get the question / compile treatment.
  if (!CREATION_INTENTS.has(brief.intentKind)) {
    return {
      kind: "passthrough",
      brief,
      reason: `intent ${brief.intentKind} not shepherded by intake`,
      route: decideRoute(brief, routeCtx)
    };
  }

  const q = decideQuestion(brief);
  routeCtx.willAsk = q.shouldAsk;
  const route = decideRoute(brief, routeCtx);

  if (q.shouldAsk && q.question) {
    return {
      kind: "clarify",
      brief,
      message: q.question.prompt,
      question: q.question,
      route
    };
  }

  return {
    kind: "proceed",
    brief,
    compiledPrompt: compileBriefPrompt(brief),
    summary: briefSummaryMessage(brief),
    route
  };
}

// =====================================================================
// lib/intent/editorTurnIntent.ts
//
// The GENERIC editor-turn router brain. It classifies a chat turn like a
// real editor would — decide whether to confirm a pending action, refine
// the current timeline, trim to the active target, resolve a scope answer,
// ask a focused question, or just pass through to the existing
// planner/agent paths.
//
// It is the FIRST classification step (before the planner) so refinement and
// control turns never fall through to a random visual search. It is
// conservative: anything it isn't sure is an editor operation returns
// "passthrough" so the existing read-only / describe / agent-command /
// intake / planner paths keep working unchanged.
//
// PURE: composes the other pure intent modules + config. NO genre/entity
// table, NO hardcoded phrases for the regression conversation. Unit-tested.
// =====================================================================

import { EDITOR_TURN } from "../config";
import { classifyFastCommand } from "./fastCommands";
import { detectRefinement, type RefineScope, type RefinementKind } from "./refinementIntent";
import { extractTopicPhrases } from "./topicPhrases";
import {
  resolveActiveTarget,
  isDurationOnlyInstruction
} from "./targetDurationMemory";

export type EditorTurnKind =
  | "confirm_pending"
  | "cancel_pending"
  | "scope_resolution"
  | "trim_to_target"
  | "refine_timeline"
  | "clarify_missing_specific_moment"
  | "passthrough";

export interface EditorTurnContext {
  hasTimeline: boolean;
  clipCount: number;
  /** A concrete pending action ("…go ahead?") is awaiting a reply. */
  hasPendingAction: boolean;
  /** A planner run is parked awaiting a "Run analysis" / "yes" (don't hijack). */
  hasPendingExecution?: boolean;
  /** A free-form clarify is awaiting an answer (don't hijack a plain "yes"). */
  hasPendingClarify?: boolean;
  /** Number of uploaded sources (decides current-vs-multi behaviour). */
  sourceCount: number;
  /** The active target duration carried from earlier turns. */
  priorTargetSeconds: number | null;
}

export interface EditorTurnIntent {
  kind: EditorTurnKind;
  confidence: number;
  normalizedText: string;
  /** The active target after this turn (latest explicit wins). */
  latestDurationSeconds: number | null;
  durationChanged: boolean;
  scope?: RefineScope;
  include: string[];
  exclude: string[];
  refinementKind?: RefinementKind;
  shouldAsk?: boolean;
  askMessage?: string;
}

// "find a specific moment" with no concrete subject → must ASK what moment.
const VAGUE_MOMENT_RE =
  /\b(find|pick|get|show|grab|look for|search for)\b[\s\w]*\b(moment|scene|part|clip|bit|spot|section)\b|\b(a|the|some|any)?\s*(specific|particular|certain)\s+(moment|scene|part|clip|bit)\b/i;

// A "proceed and build it" continuation — "then create", "create it",
// "make it", "go ahead and make the reel", "now build it", "ok create".
// When a pending action is queued, this CONFIRMS it (carries the agreed
// intent forward) rather than starting a new, subject-less search. It only
// matches when the verb stands alone (no new topic / no trailing modifier
// like "30 seconds"), so "make it vertical" or "create a cooking reel" are
// NOT swallowed.
const PROCEED_BUILD_RE =
  /^(?:so[,\s]+|ok(?:ay)?[,\s]+|yes[,\s]+|yeah[,\s]+|sure[,\s]+|then[,\s]+|now[,\s]+|and[,\s]+|please[,\s]+|go ahead and |go ahead[,\s]+)*(?:create|make|build|generate|produce|assemble|start)(?:\s+(?:it|that|this|them|one|the (?:short|reel|video|edit|clip|clips|highlights?|montage)|a (?:short|reel|video|montage)))?[\s.!]*$/i;

function clarifyMissingMomentMessage(): string {
  return (
    "Which moment do you want? Tell me what's on screen \u2014 e.g. the action, " +
    "who's doing what, a line that's said, or a rough time \u2014 and I'll find it."
  );
}

/**
 * Classify an editor turn. Always returns the resolved active target so the
 * caller can keep "latest duration wins" even on passthrough turns.
 */
export function classifyEditorTurn(text: string, ctx: EditorTurnContext): EditorTurnIntent {
  const raw = (text ?? "").trim();
  const target = resolveActiveTarget(ctx.priorTargetSeconds, raw);

  const base = {
    confidence: 0,
    normalizedText: raw,
    latestDurationSeconds: target.seconds,
    durationChanged: target.changed,
    include: [] as string[],
    exclude: [] as string[]
  };

  if (!raw) return { kind: "passthrough", ...base };

  const fast = classifyFastCommand(raw.replace(/[,;]+/g, " ").replace(/\s+/g, " ").trim());
  const refine = detectRefinement(raw);

  // 1) Confirm / cancel replies win — resolve before anything else.
  //    A bare affirmation confirms our concrete pending action. With nothing
  //    pending at all it's a stray "yes" the router answers honestly (goal 7)
  //    — NEVER a search. But when a planner run / free-form clarify is parked
  //    we must NOT hijack the "yes" (the existing run-plan flow needs it).
  const nothingElsePending = !ctx.hasPendingExecution && !ctx.hasPendingClarify;
  if (fast?.kind === "affirm" && (ctx.hasPendingAction || nothingElsePending)) {
    return { kind: "confirm_pending", ...base, confidence: 0.95, normalizedText: refine.normalizedText || raw };
  }
  if (fast?.kind === "cancel" && (ctx.hasPendingAction || nothingElsePending)) {
    return { kind: "cancel_pending", ...base, confidence: 0.95 };
  }

  // 1b) "then create" / "make it" / "go ahead and build the reel" while a
  //     concrete action is pending → CONFIRM it. This is conversational
  //     continuity: the user is agreeing to the thing we just proposed
  //     ("Want me to search for fighting?"), NOT asking for "then"/"create"
  //     moments. Requires a pending action and no NEW topic of its own.
  if (
    ctx.hasPendingAction &&
    fast?.kind !== "affirm" &&
    PROCEED_BUILD_RE.test(raw)
  ) {
    return {
      kind: "confirm_pending",
      ...base,
      confidence: 0.9,
      normalizedText: refine.normalizedText || raw
    };
  }
  // A scope answer ("from current video clips") confirms a pending action
  // with that scope rather than starting over.
  if (ctx.hasPendingAction && refine.kind === "scope_only") {
    return {
      kind: "scope_resolution",
      ...base,
      scope: refine.scope,
      confidence: 0.9,
      normalizedText: refine.normalizedText
    };
  }

  // 2) Trim-to-target is a direct timeline op (never a search).
  if (refine.kind === "trim_to_target") {
    return {
      kind: "trim_to_target",
      ...base,
      scope: refine.scope,
      confidence: EDITOR_TURN.confidence.strong,
      normalizedText: refine.normalizedText
    };
  }

  // 3) A bare duration-only instruction WITH an existing timeline → trim the
  //    current edit to the (new) active target rather than re-planning.
  if (isDurationOnlyInstruction(raw) && ctx.hasTimeline && extractTopicPhrases(raw).length === 0) {
    return {
      kind: "trim_to_target",
      ...base,
      confidence: EDITOR_TURN.confidence.strong,
      normalizedText: refine.normalizedText || raw
    };
  }

  // 4) Refinement / filter / remove content.
  if (refine.kind === "remove" || refine.kind === "keep_only" || refine.kind === "filter") {
    return {
      kind: "refine_timeline",
      ...base,
      include: refine.include,
      exclude: refine.exclude,
      refinementKind: refine.kind,
      scope: refine.scope,
      confidence: refine.confidence,
      normalizedText: refine.normalizedText,
      shouldAsk: true
    };
  }

  // 5) Scope-only answer with no pending action ("from current video clips"
  //    out of the blue) → treat as a current-scope refine/replan signal.
  if (refine.kind === "scope_only") {
    return {
      kind: "scope_resolution",
      ...base,
      scope: refine.scope,
      confidence: 0.75,
      normalizedText: refine.normalizedText
    };
  }

  // 6) Vague "find a specific moment" with no concrete subject → ASK.
  if (VAGUE_MOMENT_RE.test(raw) && extractTopicPhrases(raw).length === 0 && target.seconds === null) {
    return {
      kind: "clarify_missing_specific_moment",
      ...base,
      confidence: EDITOR_TURN.confidence.strong,
      shouldAsk: true,
      askMessage: clarifyMissingMomentMessage()
    };
  }

  // Otherwise: not an editor-control/refine turn — let existing paths handle.
  return { kind: "passthrough", ...base };
}

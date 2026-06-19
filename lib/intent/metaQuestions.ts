// =====================================================================
// lib/intent/metaQuestions.ts
//
// COMPATIBILITY SHIM. The real understanding now lives in
// `lib/intent/conversationIntent.ts` (a grammar-level + semantic classifier),
// NOT in a long exact-phrase regex table. This file keeps the small
// `MetaQuestion` shape that the deterministic answerer (`metaAnswer.ts`) and
// the read-only responder are typed against, and exposes `parseMetaQuestion`
// as a thin adapter over Layer A of the conversation classifier.
//
// There is intentionally NO list of example phrases here anymore.
// =====================================================================

import {
  classifyConversationIntentSync,
  NEUTRAL_CONTEXT,
  type ConversationContext,
  type ConversationIntent,
  type ConversationTarget
} from "./conversationIntent";

export type MetaQuestionKind =
  | "explain_previous_changes"
  | "what_changed"
  | "why_clip_selected"
  | "why_plan"
  | "what_will_happen"
  | "capability_explanation"
  | "unknown";

export interface MetaQuestion {
  kind: MetaQuestionKind;
  confidence: number;
  target?:
    | "last_action"
    | "timeline"
    | "clip"
    | "plan"
    | "render"
    | "history"
    | "capability";
}

function mapKind(target: ConversationTarget): MetaQuestionKind {
  switch (target) {
    case "capability":
      return "capability_explanation";
    case "render":
      return "what_will_happen";
    case "selected_clip":
      return "why_clip_selected";
    case "plan":
      return "why_plan";
    case "history":
      return "what_changed";
    case "timeline":
    case "last_action":
    case "source_video":
    case "unknown":
    default:
      return "explain_previous_changes";
  }
}

function mapTarget(target: ConversationTarget): MetaQuestion["target"] {
  switch (target) {
    case "selected_clip":
      return "clip";
    case "capability":
      return "capability";
    case "render":
      return "render";
    case "plan":
      return "plan";
    case "history":
      return "history";
    case "timeline":
      return "timeline";
    default:
      return "last_action";
  }
}

/**
 * Thin adapter: returns a MetaQuestion when the deterministic conversation
 * classifier (Layer A) confidently sees a READ-ONLY meta question, else null
 * (so the normal edit/planner flow runs). Kept for callers that still want
 * the simple shape; new code should use `classifyConversationIntent`.
 */
export function parseMetaQuestion(
  text: string,
  ctx: ConversationContext = NEUTRAL_CONTEXT
): MetaQuestion | null {
  const intent: ConversationIntent = classifyConversationIntentSync(text, ctx);
  if (intent.kind !== "read_only_meta" || intent.confidence < 0.6) return null;
  return {
    kind: mapKind(intent.target),
    confidence: intent.confidence,
    target: mapTarget(intent.target)
  };
}

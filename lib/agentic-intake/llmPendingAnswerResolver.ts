// =====================================================================
// lib/agentic-intake/llmPendingAnswerResolver.ts
//
// Deterministic-FIRST pending-answer resolution with a text-only LLM
// fallback. It wraps the pure `resolvePendingAnswer`:
//
//   1. Run the pure resolver (exact chip → fuzzy → contextual).
//   2. If its confidence is good enough, USE IT — no LLM call (free, instant).
//   3. Only when confidence is low/null AND the Chat Brain is ready do we ask
//      the warmed text brain, then map its strict JSON answer back to a brief
//      patch.
//   4. If the brain is unavailable / low-confidence / invalid, fall back to
//      the deterministic result (which may be null → caller re-asks).
//
// Privacy: only compact text state is sent (buildChatBrainPayload). No media.
// Deterministic commands never reach here (handled earlier in handleAgent).
//
// The mapper + decision logic are pure + injectable so they are unit-tested
// without any network.
// =====================================================================

import { CHAT_BRAIN } from "../config";
import type { ChatBrainIntent, ChatBrainPayloadInput } from "../llm/chatBrainSchema";
import { chatBrainReady, resolveWithChatBrain } from "../llm/chatBrainPreload";
import {
  resolvePendingAnswer,
  type PendingQuestionContext,
  type ResolvedAnswer
} from "./pendingAnswerResolver";
import type { MissingField } from "./editBrief";

export interface BrainResolveDeps {
  ready: () => boolean;
  resolve: (input: ChatBrainPayloadInput) => Promise<ChatBrainIntent | null>;
}

const defaultDeps: BrainResolveDeps = {
  ready: chatBrainReady,
  resolve: resolveWithChatBrain
};

export interface BrainAnswerResult {
  answer: ResolvedAnswer | null;
  /** True when the LLM brain was actually consulted this turn. */
  usedBrain: boolean;
}

/** PURE: map a ChatBrainIntent to a ResolvedAnswer for the pending field. */
export function chatBrainIntentToAnswer(
  intent: ChatBrainIntent,
  targetField: MissingField
): ResolvedAnswer | null {
  const confidence = intent.confidence;
  switch (targetField) {
    case "output_type": {
      const map: Record<string, ResolvedAnswer["patch"]> = {
        best_moments_reel: { output: { outputType: "multi_clip" }, intentKind: "highlight_reel" },
        one_continuous_short: { output: { outputType: "single_continuous" }, intentKind: "continuous_clip" },
        specific_scene: { output: { outputType: "single_continuous" }, intentKind: "specific_moment" },
        merge_as_is: { output: { outputType: "as_is_merge" }, intentKind: "merge_sources" }
      };
      const base = intent.outputType ? map[intent.outputType] : undefined;
      if (!base) return null;
      const focus = intent.contentFocus && intent.contentFocus.length > 0
        ? { content: { focus: intent.contentFocus.join(", ") } }
        : {};
      return {
        field: "output_type",
        method: "llm",
        patch: { ...base, ...focus },
        summary: intent.outputType!.replace(/_/g, " "),
        confidence
      };
    }
    case "content_focus": {
      const focus = intent.contentFocus && intent.contentFocus.length > 0
        ? intent.contentFocus.join(", ")
        : null;
      if (!focus) return null;
      return {
        field: "content_focus",
        method: "llm",
        patch: { content: { focus } },
        summary: focus,
        confidence
      };
    }
    case "source_scope": {
      const scopeMap: Record<string, string> = {
        current_video: "current",
        current_timeline: "current",
        selected_videos: "selected",
        all_uploaded: "all"
      };
      const t = intent.sourceScope ? scopeMap[intent.sourceScope] : undefined;
      if (!t) return null;
      return {
        field: "source_scope",
        method: "llm",
        patch: { sourceScope: { type: t, reason: "resolved by chat brain" } },
        summary: `${t} video`,
        confidence
      };
    }
    case "duration": {
      if (typeof intent.targetSeconds !== "number") return null;
      return {
        field: "duration",
        method: "llm",
        patch: { output: { durationSeconds: intent.targetSeconds } },
        summary: `${intent.targetSeconds}s`,
        confidence
      };
    }
    default:
      return null;
  }
}

/** PURE: should we even consult the brain given the deterministic result? */
export function shouldConsultBrain(det: ResolvedAnswer | null, brainReady: boolean): boolean {
  if (!brainReady) return false;
  if (!CHAT_BRAIN.useOnlyForLowConfidence) return true;
  if (!det) return true; // deterministic found nothing → try the brain
  return det.confidence < CHAT_BRAIN.confidenceThreshold;
}

/**
 * Resolve the pending answer, deterministic-first with an LLM fallback only
 * when confidence is low. `state` carries the privacy-safe context the brain
 * may use (no media). `deps` is injectable for tests.
 */
export async function resolvePendingAnswerWithBrain(
  userText: string,
  ctx: PendingQuestionContext,
  state: Omit<ChatBrainPayloadInput, "userMessage"> = {},
  deps: BrainResolveDeps = defaultDeps
): Promise<BrainAnswerResult> {
  const det = resolvePendingAnswer(userText, ctx);

  if (!shouldConsultBrain(det, deps.ready())) {
    return { answer: det, usedBrain: false };
  }

  let intent: ChatBrainIntent | null = null;
  try {
    intent = await deps.resolve({
      ...state,
      userMessage: userText,
      pendingQuestion: {
        id: ctx.question.id,
        prompt: ctx.question.prompt,
        suggestions: ctx.question.suggestions
      }
    });
  } catch {
    intent = null;
  }

  if (!intent || intent.confidence < CHAT_BRAIN.minApplyConfidence) {
    return { answer: det, usedBrain: true };
  }

  const brainAnswer = chatBrainIntentToAnswer(intent, ctx.targetField);
  if (brainAnswer && brainAnswer.confidence >= CHAT_BRAIN.minApplyConfidence) {
    // Prefer the brain answer only when it is at least as confident as the
    // deterministic one (which was low by definition here).
    if (!det || brainAnswer.confidence >= det.confidence) {
      return { answer: brainAnswer, usedBrain: true };
    }
  }
  return { answer: det, usedBrain: true };
}

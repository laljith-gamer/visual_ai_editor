// =====================================================================
// lib/agent/conversationLane.ts
//
// CLIENT bridge for the read-only conversation lane. Wires the PURE
// conversation-intent classifier + read-only responder to the live editor
// store and (optionally, only when already loaded) the local LLM. Used by
// both the editor's handleAgent and runAgentCommand so the read-only guard
// is defined in ONE place.
//
// Read-only by contract: nothing here mutates the store.
// =====================================================================

import { useEditorStore } from "@/hooks/useEditorStore";
import {
  classifyConversationIntent,
  classifyConversationIntentSync,
  type ConversationContext,
  type ConversationIntent,
  type SemanticClassifyFn
} from "@/lib/intent/conversationIntent";
import { answerReadOnly, deterministicAnswer, type ReadOnlyState } from "@/lib/agent/readOnlyResponder";
import { buildDescribeResponse, type DescribeResponse } from "@/lib/agent/describeResponder";
import { detectDeviceTier } from "@/lib/analysis/deviceTier";
import { getCachedVideoMemory } from "@/lib/analysis/videoMemoryManager";

/** Snapshot the live store into the classifier's context. */
export function buildConversationContext(): ConversationContext {
  const s = useEditorStore.getState();
  return {
    hasTimeline: s.highlights.length > 0,
    clipCount: s.highlights.length,
    hasPlan: Boolean(s.plan),
    hasSelectedClip: Boolean(s.selectedClipId),
    hasRenderedOutput: Boolean(s.renderedUrl),
    pendingClarify: Boolean(s.pendingClarify)
  };
}

/** Snapshot the live store into the read-only responder's state. */
export function buildReadOnlyState(questionText: string): ReadOnlyState {
  const s = useEditorStore.getState();
  const lastAssistant = [...s.messages].reverse().find((m) => m.role === "assistant")?.content ?? null;
  const lastUser = [...s.messages].reverse().find((m) => m.role === "user")?.content ?? null;
  return {
    questionText,
    plan: s.plan
      ? {
          targetShortSeconds: s.plan.targetShortSeconds,
          userSpecifiedDuration: s.plan.userSpecifiedDuration,
          format: s.plan.format,
          transition: s.plan.transition,
          scenarios: s.plan.scenarios?.map((sc) => ({ id: sc.id, prompt: sc.prompt })),
          rationale: s.plan.rationale
        }
      : null,
    highlights: s.highlights.map((h) => ({
      id: h.id,
      start: h.start,
      end: h.end,
      label: h.label,
      reason: h.reason,
      sourceId: h.sourceId,
      score: h.score
    })),
    selectedClipId: s.selectedClipId,
    boundaryTransitions: s.boundaryTransitions.map((t) => ({
      index: t.index,
      type: t.type,
      mode: t.mode,
      render: t.render,
      exact: t.exact,
      note: t.note
    })),
    memory: s.memory,
    sources: s.sources.map((src) => ({ id: src.id, name: src.meta.name })),
    lastAssistantMessage: lastAssistant,
    lastUserMessage: lastUser,
    renderStatus: s.status,
    hasRenderedOutput: Boolean(s.renderedUrl)
  };
}

/** A local semantic classifier — ONLY when the engine is already loaded, so
 *  we never trigger a fresh model download just to classify a question. */
async function localSemanticClassifier(): Promise<SemanticClassifyFn | undefined> {
  try {
    const { isWebGPUAvailable, isLocalEngineReady, localChatJson } = await import(
      "@/lib/local-llm/webllm"
    );
    if (!isWebGPUAvailable() || !isLocalEngineReady()) return undefined;
    return (system, user) => localChatJson(system, user, { maxTokens: 240, temperature: 0 });
  } catch {
    return undefined;
  }
}

/** A local natural-answer generator — ONLY when the engine is already loaded. */
async function localAnswerGenerator(): Promise<
  ((system: string, user: string) => Promise<string>) | undefined
> {
  try {
    const { isWebGPUAvailable, isLocalEngineReady, localChatText } = await import(
      "@/lib/local-llm/webllm"
    );
    if (!isWebGPUAvailable() || !isLocalEngineReady()) return undefined;
    return (system, user) => localChatText(system, user, { maxTokens: 320, temperature: 0.4 });
  } catch {
    return undefined;
  }
}

/**
 * Classify a turn. Uses Layer A (deterministic) and, for ambiguous turns,
 * Layer B (the local LLM) only when it's already loaded.
 */
export async function classifyTurn(text: string): Promise<ConversationIntent> {
  const ctx = buildConversationContext();
  const semanticClassify = await localSemanticClassifier();
  return classifyConversationIntent(text, ctx, { semanticClassify });
}

/** Synchronous Layer-A-only classification (cheap double-safety guard). */
export function classifyTurnSync(text: string): ConversationIntent {
  return classifyConversationIntentSync(text, buildConversationContext());
}

/** Produce a read-only answer for a classified meta turn (natural via local
 *  LLM when ready, else deterministic). NEVER mutates the store. */
export async function respondReadOnly(intent: ConversationIntent, text: string): Promise<string> {
  const state = buildReadOnlyState(text);
  const generate = await localAnswerGenerator();
  return answerReadOnly(intent, state, { generate });
}

/** Deterministic-only read-only answer (used by the sync double-safety guard). */
export function respondReadOnlySync(intent: ConversationIntent, text: string): string {
  return deterministicAnswer(intent, buildReadOnlyState(text));
}

/**
 * Build an honest, INSTANT response to a "describe this video" turn from the
 * live store. NEVER mutates state and NEVER runs the highlight pipeline — it
 * answers from metadata (+ transcript presence) and, when a local scan has
 * already run, from the cached structural VideoAnalysisMemory (so a describe
 * after a quick scan is richer + honest about local limits).
 */
export function respondDescribe(): DescribeResponse {
  const s = useEditorStore.getState();
  const active = s.sources.find((src) => src.id === s.activeSourceId) ?? s.sources[0] ?? null;
  const hasTranscript = active ? Boolean(s.transcripts?.[active.hash]) : false;
  let deviceTier: ReturnType<typeof detectDeviceTier> | undefined;
  try {
    deviceTier = detectDeviceTier();
  } catch {
    deviceTier = undefined;
  }
  return buildDescribeResponse({
    hasVideo: Boolean(active),
    sourceName: active?.meta.name,
    durationSeconds: active?.meta.duration,
    width: active?.meta.width,
    height: active?.meta.height,
    hasTranscript,
    memory: active ? getCachedVideoMemory(active.hash) : null,
    deviceTier
  });
}

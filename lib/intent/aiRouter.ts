// =====================================================================
// lib/intent/aiRouter.ts
//
// Unified AI intent router — the PRIMARY brain for understanding
// what the user wants. Replaces ~15 regex/keyword-based classifiers.
//
// Flow:
//   1. Try the tiny control-command regex (undo/redo/render/export)
//   2. Call /api/agent/intent { task: "route" } with the user's text
//      + compact editor state → get structured AIIntentResult
//   3. If AI is unavailable, return { action: "unavailable" }
//
// The AI handles ALL understanding: typo correction, multi-step
// commands, context-aware routing, topics, durations, source/clip
// references — things that regex can never do well.
//
// Privacy: only compact text state is sent. Never video/frames/blobs.
// =====================================================================

import type { AIIntentResult, AIRouterContext, AIAction } from "./aiIntentTypes";
import { classifyControlCommand } from "./controlCommand";

/** Configuration for the AI router. */
export interface AIRouterConfig {
  /** Timeout in ms for the AI call. Default: 8000. */
  timeoutMs?: number;
  /** When true, skip the AI call and only try control commands. */
  offlineOnly?: boolean;
}

/**
 * Route a user message through the AI intent classifier.
 *
 * Returns a structured AIIntentResult describing exactly what the user
 * wants, with typed parameters. Returns { action: "unavailable" } when
 * the AI cannot be reached and the message isn't a control command.
 */
export async function routeIntent(
  userText: string,
  context: AIRouterContext,
  config?: AIRouterConfig
): Promise<AIIntentResult> {
  const text = (userText ?? "").trim();
  if (!text) {
    return makeUnavailable("Empty message");
  }

  // 1. Tiny safe control commands (4 patterns, instant, no AI needed)
  const control = classifyControlCommand(text);
  if (control) {
    return {
      action: control.action as AIAction,
      confidence: 1.0,
      reasoning: `Matched control command: ${control.action}`,
      normalizedText: text
    };
  }

  // 2. If offline-only mode, return unavailable for everything else
  if (config?.offlineOnly) {
    return makeUnavailable("AI router is in offline-only mode");
  }

  // 3. Call the AI intent endpoint
  try {
    const timeoutMs = config?.timeoutMs ?? 8000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch("/api/agent/intent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "route",
        userMessage: text,
        context: {
          uploadedVideos: context.uploadedVideoCount,
          selectedVideos: context.selectedVideoCount,
          timelineClips: context.timelineClipCount,
          hasRenderedOutput: context.hasRenderedOutput,
          hasPendingAction: context.hasPendingAction,
          pendingActionKind: context.pendingActionKind,
          hasPendingQuestion: context.hasPendingQuestion,
          pendingQuestionText: context.pendingQuestionText,
          pendingQuestionSuggestions: context.pendingQuestionSuggestions,
          activeTargetSeconds: context.activeTargetSeconds,
          activeSubject: context.activeSubject,
          sourceNames: context.sourceNames,
          previousAssistantMessage: context.previousAssistantMessage
        }
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return makeUnavailable(`AI router returned ${response.status}`);
    }

    const data = await response.json();

    // Map the raw response to our typed AIIntentResult
    return parseAIResponse(data, text);
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return makeUnavailable("AI router timed out");
    }
    return makeUnavailable(
      `AI router error: ${(err as Error).message?.slice(0, 100)}`
    );
  }
}

/**
 * Build an AIRouterContext from the current editor store state.
 * Call this once per turn, before routeIntent.
 */
export function buildRouterContext(storeState: {
  sources: Array<{ id: string; meta: { name: string } }>;
  selectedSourceIds: string[];
  highlights: unknown[];
  renderedBlob: unknown;
  pendingAction: { kind: string } | null;
  pendingExecution: boolean;
  pendingClarify: { message: string; questions: Array<{ prompt: string; suggestions: string[] }> } | null;
  activeTargetSeconds: number | null;
  plan: { scenarios: Array<{ prompt: string }> } | null;
  messages: Array<{ role: string; content: string }>;
}): AIRouterContext {
  // Find the last assistant message for context
  let prevAssistant: string | undefined;
  for (let i = storeState.messages.length - 1; i >= 0; i--) {
    if (storeState.messages[i].role === "assistant") {
      prevAssistant = storeState.messages[i].content;
      break;
    }
  }

  const pendingQ = storeState.pendingClarify?.questions?.[0];

  return {
    uploadedVideoCount: storeState.sources.length,
    selectedVideoCount: storeState.selectedSourceIds.length,
    timelineClipCount: storeState.highlights.length,
    hasRenderedOutput: !!storeState.renderedBlob,
    hasPendingAction: !!storeState.pendingAction || storeState.pendingExecution,
    pendingActionKind: storeState.pendingAction?.kind,
    hasPendingQuestion: !!storeState.pendingClarify,
    pendingQuestionText: pendingQ?.prompt,
    pendingQuestionSuggestions: pendingQ?.suggestions,
    activeTargetSeconds: storeState.activeTargetSeconds,
    activeSubject: storeState.plan?.scenarios?.[0]?.prompt ?? null,
    sourceNames: storeState.sources.map((s) => s.meta.name),
    previousAssistantMessage: prevAssistant?.slice(0, 500)
  };
}

// ---- Internal helpers ----

function makeUnavailable(reason: string): AIIntentResult {
  return {
    action: "unavailable",
    confidence: 0,
    reasoning: reason,
    normalizedText: ""
  };
}

/** Valid actions the AI can return. Used for validation. */
const VALID_ACTIONS = new Set<AIAction>([
  "add_clip", "remove_clip", "move_clip", "trim_clip", "extend_clip",
  "replace_clip", "split_clip", "create_highlight", "find_moment",
  "describe_video", "scan_video", "merge_videos", "compose_montage",
  "trim_to_target", "refine_timeline", "set_transition",
  "auto_transitions", "remove_transitions", "render", "export",
  "undo", "redo", "set_format", "select_source", "switch_source",
  "confirm_pending", "cancel_pending", "answer_question", "chat",
  "read_only_question", "clarify", "passthrough", "unavailable"
]);

function parseAIResponse(
  data: Record<string, unknown>,
  originalText: string
): AIIntentResult {
  const action = typeof data.action === "string" && VALID_ACTIONS.has(data.action as AIAction)
    ? (data.action as AIAction)
    : "passthrough";

  const params = (typeof data.parameters === "object" && data.parameters !== null
    ? data.parameters
    : {}) as Record<string, unknown>;

  const result: AIIntentResult = {
    action,
    confidence: typeof data.confidence === "number" ? data.confidence : 0.5,
    reasoning: typeof data.reasoning === "string" ? data.reasoning : "",
    normalizedText: typeof data.normalizedText === "string"
      ? data.normalizedText
      : originalText
  };

  // Map parameters to typed fields
  if (typeof params.durationSeconds === "number") {
    result.durationSeconds = params.durationSeconds;
  }
  if (typeof params.duration === "number") {
    result.durationSeconds = params.duration;
  }
  if (Array.isArray(params.topics)) {
    result.topics = params.topics.filter((t): t is string => typeof t === "string");
  }
  if (Array.isArray(params.contentFocus)) {
    result.topics = (params.contentFocus as unknown[]).filter((t): t is string => typeof t === "string");
  }
  if (Array.isArray(params.excludeTopics)) {
    result.excludeTopics = params.excludeTopics.filter((t): t is string => typeof t === "string");
  }
  if (typeof params.format === "string") {
    const f = params.format as string;
    if (f === "vertical" || f === "horizontal" || f === "square") {
      result.format = f;
    }
  }
  if (typeof params.replaceTimeline === "boolean") {
    result.replaceTimeline = params.replaceTimeline;
  }

  // Time range
  if (params.startTime != null || params.endTime != null || params.timeRange) {
    const tr = (params.timeRange ?? {}) as Record<string, unknown>;
    result.timeRange = {
      kind: typeof tr.kind === "string" ? tr.kind as "first" | "last" | "middle" | "absolute" : "absolute",
      startSeconds: typeof (params.startTime ?? tr.startSeconds) === "number"
        ? (params.startTime ?? tr.startSeconds) as number : undefined,
      endSeconds: typeof (params.endTime ?? tr.endSeconds) === "number"
        ? (params.endTime ?? tr.endSeconds) as number : undefined,
      durationSeconds: typeof tr.durationSeconds === "number"
        ? tr.durationSeconds : undefined
    };
  }

  // Source ref
  if (params.sourceRef || params.videos) {
    const sr = (params.sourceRef ?? {}) as Record<string, unknown>;
    if (typeof sr.type === "string") {
      result.sourceRef = {
        type: sr.type as "index" | "name" | "active" | "all" | "selected",
        index: typeof sr.index === "number" ? sr.index : undefined,
        name: typeof sr.name === "string" ? sr.name : undefined
      };
    }
  }

  // Clip ref
  if (params.clipRef) {
    const cr = params.clipRef as Record<string, unknown>;
    if (typeof cr.type === "string") {
      result.clipRef = {
        type: cr.type as "index" | "first" | "last" | "selected" | "all",
        index: typeof cr.index === "number" ? cr.index : undefined
      };
    }
  }

  // Transition
  if (typeof params.transitionType === "string") {
    result.transitionType = params.transitionType as AIIntentResult["transitionType"];
  }

  // Clarification
  if (typeof data.question === "string") {
    result.clarifyMessage = data.question;
  }
  if (typeof data.clarifyMessage === "string") {
    result.clarifyMessage = data.clarifyMessage;
  }
  if (Array.isArray(data.suggestions)) {
    result.suggestions = data.suggestions.filter((s): s is string => typeof s === "string");
  }

  // Chat reply
  if (typeof data.chatReply === "string") {
    result.chatReply = data.chatReply;
  }
  if (typeof data.reply === "string") {
    result.chatReply = data.reply;
  }

  // Sequence (multi-step)
  if (Array.isArray(params.sequence)) {
    result.sequence = (params.sequence as Record<string, unknown>[])
      .map((step) => parseAIResponse(step, originalText))
      .filter((s) => s.action !== "passthrough");
  }

  return result;
}

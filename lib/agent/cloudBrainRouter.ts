// =====================================================================
// lib/agent/cloudBrainRouter.ts
//
// Makes the OpenRouter (cloud) model the AUTHORITATIVE intent/route decider
// when the user has selected the cloud brain. Instead of letting the
// deterministic regex/keyword parsers (editor-turn router, tryAgentCommand,
// intake, quick-shortcut) guess the route first — which produced keyword
// soup, the "Which video?" loop, and mis-parsed subjects — the chat turn is
// classified by the model via the existing /api/agent/intent {task:"resolve"}
// endpoint, and this module maps the model's structured ChatBrainIntent into
// a concrete action the editor executes.
//
// IMPORTANT: this is ONLY consulted when the cloud brain is selected AND
// configured. When OpenRouter is unavailable the resolve call returns null
// and the caller falls straight back to the deterministic / on-device path,
// so the local-first / offline default is completely unchanged.
//
// No hardcoded command tables or genre/content keyword lists live here — the
// model decides the route; this module only shapes the model's own structured
// output into an action + a clean planner brief. PURE (except the one network
// helper). Unit-tested.
// =====================================================================

import {
  buildChatBrainPayload,
  type ChatBrainIntent,
  type ChatBrainPayloadInput
} from "../llm/chatBrainSchema";

/**
 * The concrete action the editor should take, derived from the model's route.
 *
 *  - "plan"        → bypass the deterministic interceptors and let the
 *                    OpenRouter planner build/refine the edit. `replace`
 *                    requests a fresh timeline (create / re-pick).
 *  - "describe"    → answer the "what's in this video" question honestly.
 *  - "ask"         → the model wants one clarifying question (surface it).
 *  - "passthrough" → defer to the existing deterministic pipeline (used for
 *                    read-only, confirm/cancel, pending answers, trim, and
 *                    any low-confidence/unknown turn — all of which the
 *                    existing reliable handlers cover well).
 */
export type CloudRouteAction =
  | { kind: "plan"; compiledPrompt: string; replace: boolean }
  | { kind: "describe" }
  | { kind: "ask"; message: string; suggestions?: string[] }
  | { kind: "passthrough" };

/** Below this confidence we never override the deterministic pipeline. */
const MIN_ROUTE_CONFIDENCE = 0.45;

/**
 * Compile the model's structured slots into a single clean planner brief.
 * The model already returns typo-fixed text (normalizedUserText); we append
 * only the structured hints it extracted (output type, scope, duration,
 * include/exclude, style). No content/genre tables — every value comes from
 * the model's own output.
 */
export function compileCloudBrief(intent: ChatBrainIntent): string {
  const parts: string[] = [];
  const base = (intent.normalizedUserText ?? "").trim();
  if (base) parts.push(base);

  switch (intent.outputType) {
    case "best_moments_reel":
      parts.push("Build a highlight reel of the best moments.");
      break;
    case "one_continuous_short":
      parts.push("Keep one continuous clip (no jump cuts).");
      break;
    case "specific_scene":
      parts.push("Find the specific scene the user described.");
      break;
    case "merge_as_is":
      parts.push("Merge the videos as-is, in order.");
      break;
    default:
      break;
  }

  switch (intent.sourceScope) {
    case "all_uploaded":
      parts.push("Use all uploaded videos.");
      break;
    case "selected_videos":
      parts.push("Use the videos selected for AI.");
      break;
    case "current_video":
      parts.push("Use the current video.");
      break;
    case "current_timeline":
      parts.push("Work from the current timeline.");
      break;
    default:
      break;
  }

  if (typeof intent.targetSeconds === "number") {
    parts.push(`Target length: about ${intent.targetSeconds} seconds.`);
  }

  const includes =
    intent.includeConcepts && intent.includeConcepts.length > 0
      ? intent.includeConcepts
      : intent.contentFocus && intent.contentFocus.length > 0
        ? intent.contentFocus
        : [];
  if (includes.length > 0) parts.push(`Focus on: ${includes.join(", ")}.`);

  if (intent.excludeConcepts && intent.excludeConcepts.length > 0) {
    parts.push(`Avoid: ${intent.excludeConcepts.join(", ")}.`);
  }

  if (intent.style) parts.push(`Style: ${intent.style}.`);

  return parts.join(" ").trim();
}

/**
 * Map a validated ChatBrainIntent to a concrete editor action. PURE.
 *
 * Content routes (create / refine) bypass the deterministic interceptors and
 * go to the OpenRouter planner — this is the class of turns the deterministic
 * parsers mis-handled. Everything else (read-only, confirm/cancel, pending
 * answers, trim-to-target) passes through to the existing reliable handlers.
 */
export function planCloudAction(intent: ChatBrainIntent): CloudRouteAction {
  if (intent.confidence < MIN_ROUTE_CONFIDENCE) return { kind: "passthrough" };

  switch (intent.route) {
    case "create_highlight":
      return { kind: "plan", compiledPrompt: compileCloudBrief(intent), replace: true };
    case "refine_timeline":
      return { kind: "plan", compiledPrompt: compileCloudBrief(intent), replace: true };
    case "describe_video":
      return { kind: "describe" };
    case "ask_clarifying_question":
      return intent.askMessage
        ? {
            kind: "ask",
            message: intent.askMessage,
            ...(intent.suggestions && intent.suggestions.length > 0
              ? { suggestions: intent.suggestions }
              : {})
          }
        : { kind: "passthrough" };
    // read-only, confirm/cancel pending, answer-pending, trim-to-target and
    // anything else are handled reliably by the existing deterministic
    // handlers — defer to them.
    case "read_only":
    case "confirm_pending":
    case "cancel_pending":
    case "answer_pending_question":
    case "trim_to_target":
    case "passthrough":
    default:
      return { kind: "passthrough" };
  }
}

/**
 * Ask the OpenRouter intent router to classify this turn. Returns null when
 * the cloud brain isn't configured/reachable or the response isn't usable —
 * the caller then falls back to the deterministic / on-device pipeline.
 *
 * The payload is built by buildChatBrainPayload, the single privacy boundary:
 * it carries ONLY compact text state (never frames/audio/transcripts/keys).
 */
export async function resolveCloudBrainIntent(
  input: ChatBrainPayloadInput
): Promise<ChatBrainIntent | null> {
  try {
    const payload = buildChatBrainPayload(input);
    const res = await fetch("/api/agent/intent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as
      | { intent?: ChatBrainIntent | null }
      | null;
    const intent = data?.intent ?? null;
    if (!intent) return null;

    // Memory carry (deterministic safety net): if the model dropped the
    // duration but the user set one on an earlier turn, restore it so a
    // subject-only follow-up ("combat scene on this") still targets the
    // remembered length instead of falling back to a generic default.
    if (
      (intent.targetSeconds === null || intent.targetSeconds === undefined) &&
      typeof input.activeTargetSeconds === "number"
    ) {
      intent.targetSeconds = input.activeTargetSeconds;
    }
    return intent;
  } catch {
    return null;
  }
}

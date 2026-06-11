// =====================================================================
// lib/llm/localFirst.ts
//
// PHASE 4 — flag-gated entry point that wires the merged local-first
// language layer into the live assistant path.
//
// Design (deliberately conservative for v1):
//   - Behind NEXT_PUBLIC_LOCAL_FIRST_EDITOR. Default OFF → the existing
//     Gemini/Groq flow is byte-for-byte unchanged.
//   - When ON, we run the model-driven router (routeTurn) BEFORE the cloud
//     call. We only ACT locally on the safest, highest-value decision:
//     `chat` — answering questions/explanations on-device with grounding,
//     which is exactly the class of turn that the old keyword→cloud path
//     handled worst. For every action decision (plan/extract/promote/
//     edit/merge/describe/reset) and for any low-confidence/failed/
//     unsupported case, we FALL THROUGH to the unchanged cloud planner.
//
// Why not execute actions locally yet: mapping tool decisions onto the
// editor's mutation pipeline is a larger, riskier change and the spec
// says not to half-wire it (and not to fake frame data for vision-core).
// Handling `chat` locally makes routeTurn + grounding LIVE (no longer
// dead code) with zero risk to the timeline, and is independently
// shippable. Action execution is a documented follow-up.
//
// This module performs NO cloud calls and never throws to the caller:
// any problem returns { handled: false } so the caller proceeds to cloud.
// =====================================================================

import {
  routeTurn,
  buildChatGrounding,
  chatOnce,
  type ToolRouteContext,
  type BriefingLike,
  type LocalChatMessage
} from "@/lib/llm";
import { LOCAL_FIRST } from "@/lib/config";
import type { CapabilityTier } from "@/lib/types";

/** Is the local-first editor path enabled via the build-time flag? */
export function isLocalFirstEnabled(): boolean {
  return process.env.NEXT_PUBLIC_LOCAL_FIRST_EDITOR === "true";
}

export interface LocalFirstContext {
  tier: CapabilityTier;
  /** Conversation so far (most recent last), already trimmed by caller. */
  messages: LocalChatMessage[];
  /** Latest user text (for grounding + router). */
  userText: string;
  /** Active video duration in seconds, when known. */
  videoDurationSeconds?: number;
  /** Number of clips currently on the timeline. */
  timelineClipCount?: number;
  /** The most recent briefing, when in scope (for grounding + routing). */
  briefing?: BriefingLike | null;
  /** Optional progress callback (model download/compile). */
  onProgress?: (p: { progress: number; text: string }) => void;
  signal?: AbortSignal;
}

export type LocalFirstResult =
  /** The turn was fully handled locally — show `message`, do nothing else. */
  | { handled: true; kind: "chat"; message: string; model: string }
  /** Not handled locally — caller must run the existing cloud planner. */
  | { handled: false; reason: string };

/**
 * Attempt to handle a turn locally. Returns { handled:false } whenever the
 * flag is off, the device can't run a local model, the router defers to an
 * ACTION (which the cloud planner still owns for now), confidence is low,
 * or anything fails. Never throws.
 */
export async function tryLocalFirst(
  ctx: LocalFirstContext
): Promise<LocalFirstResult> {
  if (!isLocalFirstEnabled()) return { handled: false, reason: "flag_off" };

  const hasBriefing =
    !!ctx.briefing &&
    Array.isArray(ctx.briefing.bestParts) &&
    ctx.briefing.bestParts.length > 0;

  const routeCtx: ToolRouteContext = {
    videoMeta: ctx.videoDurationSeconds
      ? { duration: ctx.videoDurationSeconds }
      : undefined,
    highlightsCount: ctx.timelineClipCount,
    hasBriefing,
    briefingPartCount: hasBriefing ? ctx.briefing!.bestParts.length : 0
  };

  const outcome = await routeTurn({
    tier: ctx.tier,
    enabled: true,
    messages: ctx.messages,
    context: routeCtx,
    onProgress: ctx.onProgress,
    signal: ctx.signal
  });

  if (!outcome.handled) {
    // disabled / unsupported / load_failed / infer_failed / bad_json /
    // aborted — all fall through to the cloud planner.
    return { handled: false, reason: outcome.reason };
  }

  const { decision, model } = outcome;

  // v1: only ACT on `chat`. Everything else defers to the cloud planner,
  // which already owns the full action pipeline. Low-confidence chat also
  // defers so we don't answer with a weak local reply when the cloud can
  // do better.
  if (decision.tool !== "chat") {
    return { handled: false, reason: `route_action_${decision.tool}` };
  }
  if (decision.confidence < LOCAL_FIRST.minChatConfidence) {
    return { handled: false, reason: "low_confidence_chat" };
  }

  // Produce a grounded chat answer. The router already returned a candidate
  // `message`, but we regenerate with explicit grounding (briefing reasons,
  // footage/timeline context) so questions like "why are these the best
  // parts" are answered from real data, not just the router's first pass.
  const grounding = buildChatGrounding({
    briefing: hasBriefing ? ctx.briefing : null,
    videoDurationSeconds: ctx.videoDurationSeconds,
    timelineClipCount: ctx.timelineClipCount
  });

  let answer = decision.message;
  try {
    const streamed = await chatOnce({
      tier: ctx.tier,
      enabled: true,
      messages: ctx.messages,
      grounding,
      signal: ctx.signal
    });
    if (streamed && streamed.trim().length > 0) answer = streamed.trim();
  } catch {
    // Keep the router's message if the grounded pass fails.
  }

  if (!answer || answer.trim().length === 0) {
    // No usable answer — let the cloud handle it rather than show nothing.
    return { handled: false, reason: "empty_local_answer" };
  }

  return { handled: true, kind: "chat", message: answer, model };
}

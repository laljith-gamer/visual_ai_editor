// =====================================================================
// lib/llm/localFirst.ts
//
// PHASE 4 / 4.5 — flag-gated entry point that wires the merged local-first
// language layer into the live assistant path.
//
// Design (deliberately conservative):
//   - Behind NEXT_PUBLIC_LOCAL_FIRST_EDITOR. Default OFF → the existing
//     Gemini/Groq flow is byte-for-byte unchanged.
//   - When ON, we run the model-driven router (routeTurn) BEFORE the cloud
//     call, then act locally on a SMALL, SAFE set of outcomes:
//       * `chat`  — answer questions/explanations on-device with grounding.
//       * `promote` — lift the briefing's already-found best parts onto
//                     the timeline (deterministic store action).
//       * `extract` — grab an exact verbatim time slice (pure builder).
//       * `reset`   — clear the timeline.
//     These are the deterministic, low-risk decisions that map 1:1 onto
//     existing tested editor paths. Everything else (plan / moment / edit /
//     merge / describe) and every low-confidence/failed/unsupported case
//     FALLS THROUGH to the unchanged cloud planner.
//
// Why not execute plan/moment/edit/merge/describe locally yet: they need
// scoring, a vision call, or real sampled/captioned frame-tree data — and
// the spec is explicit that we must NOT fake frame data for vision-core.
// They remain cloud-owned (a documented follow-up) while the router still
// gets to DECIDE them; we simply defer execution.
//
// Separation of concerns: this module DECIDES (returns a typed result); it
// performs NO store mutation and NO cloud call, and never throws. The
// caller (app/editor/page.tsx) executes the action via the same store
// actions the cloud handlers use. Any problem returns { handled: false }
// so the caller proceeds to cloud.
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
  /** A safe, deterministic editor action the caller should EXECUTE locally
   *  (no cloud planner). `message` is the assistant line to show. */
  | { handled: true; kind: "action"; action: LocalEditorAction; message: string; model: string }
  /** Not handled locally — caller must run the existing cloud planner. */
  | { handled: false; reason: string };

/**
 * The closed set of deterministic, low-risk actions the local-first path
 * is allowed to execute on-device (Phase 4.5). Each maps 1:1 onto an
 * existing, already-tested editor/store path:
 *   - promote → store.promoteBriefingParts (briefing best parts → clips)
 *   - extract → buildExtractedHighlight (exact verbatim slice)
 *   - reset   → clear the timeline
 *
 * Everything else (plan / moment / edit / merge / describe) stays
 * cloud-owned for now — those need scoring, vision, or real frame-tree
 * grounding we must not fake. The router still DECIDES those; we just
 * fall through so the cloud planner executes them.
 */
export type LocalEditorAction =
  | {
      tool: "promote";
      partIds?: string[];
      targetSeconds?: number;
      op: "append" | "replace";
    }
  | {
      tool: "extract";
      range: { kind: "first" | "last" | "absolute"; startSeconds: number; endSeconds: number };
    }
  | { tool: "reset" };

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

  // ---- Safe deterministic ACTIONS (Phase 4.5) -------------------------
  // We execute ONLY the low-risk, fully-deterministic tools locally; each
  // maps onto an existing tested editor path. Anything else (plan/moment/
  // edit/merge/describe) defers to the cloud planner, which owns scoring/
  // vision/grounding we must not fake. Below the action-confidence floor
  // we also defer — a wrong local edit mutates the user's timeline.
  if (decision.tool !== "chat") {
    if (decision.confidence < LOCAL_FIRST.minActionConfidence) {
      return { handled: false, reason: "low_confidence_action" };
    }

    if (decision.tool === "promote") {
      // Promote needs briefing best parts in scope; without them only the
      // cloud path (which can ask/clarify) is appropriate.
      if (!hasBriefing) return { handled: false, reason: "promote_no_briefing" };
      return {
        handled: true,
        kind: "action",
        model,
        message: decision.message,
        action: {
          tool: "promote",
          partIds: decision.args.partIds,
          targetSeconds: decision.args.targetSeconds,
          op: decision.args.op ?? "append"
        }
      };
    }

    if (decision.tool === "extract") {
      // Need a concrete range AND a known video to clamp against.
      if (!decision.args.extractRange || ctx.videoDurationSeconds == null) {
        return { handled: false, reason: "extract_missing_range" };
      }
      return {
        handled: true,
        kind: "action",
        model,
        message: decision.message,
        action: { tool: "extract", range: decision.args.extractRange }
      };
    }

    if (decision.tool === "reset") {
      return {
        handled: true,
        kind: "action",
        model,
        message: decision.message,
        action: { tool: "reset" }
      };
    }

    // plan / moment / edit / merge / describe — cloud still owns these.
    return { handled: false, reason: `route_action_${decision.tool}` };
  }

  // ---- CHAT — answer on-device with grounding -------------------------
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

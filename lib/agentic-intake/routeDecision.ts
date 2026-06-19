// =====================================================================
// lib/agentic-intake/routeDecision.ts
//
// Capability-aware router for the agentic intake layer. Given a built
// EditBrief + context, it decides WHERE the request should go:
//
//   - fast_command   : known control command (render/export/undo) — handled
//                      by the existing fast path, intake must not intercept.
//   - vision_briefing: "what's in this video?" — needs visual understanding
//                      the text-only local planner can't provide. Route to
//                      the cloud briefing/vision path, or honestly say it's
//                      unsupported when no cloud vision is available.
//   - clarify        : a required decision is genuinely missing → ask one Q.
//   - deterministic  : a verbatim time-range extract / as-is merge that
//                      needs no semantic planning.
//   - cloud_planner  : semantic edit planning, cloud available.
//   - local_planner  : semantic edit planning, cloud unavailable but local
//                      text planner is available.
//   - manual_fallback: nothing automated can run — guide the user manually.
//
// PURE: no React, no store, no API.
// =====================================================================

import type { EditBrief } from "./editBrief";

export type RouteTarget =
  | "fast_command"
  | "vision_briefing"
  | "clarify"
  | "deterministic"
  | "cloud_planner"
  | "local_planner"
  | "manual_fallback";

/** Capability + environment facts the router needs. */
export interface RouteContext {
  /** A cloud planner/vision endpoint is reachable + enabled. */
  cloudAvailable: boolean;
  /** A local (on-device, text-only) planner is usable (WebGPU + flag). */
  localPlannerAvailable: boolean;
  /** Cloud VISION (frame understanding) specifically is available. */
  cloudVisionAvailable?: boolean;
  /** True when the question engine wants to ask (a required field missing). */
  willAsk: boolean;
}

export interface RouteResult {
  target: RouteTarget;
  reason: string;
}

/**
 * Decide the route for a brief. Capability-aware and honest: it never
 * routes a "describe the video" ask to a text-only local planner, and it
 * never promises an automated path that can't run.
 */
export function decideRoute(brief: EditBrief, ctx: RouteContext): RouteResult {
  // 1) Known control command — leave to the existing fast path.
  if (brief.intentKind === "export_render") {
    return { target: "fast_command", reason: "render/export is a fast control command" };
  }

  // 2) Visual understanding ask — text-only planners can't see frames.
  if (brief.intentKind === "describe_video") {
    if (ctx.cloudVisionAvailable ?? ctx.cloudAvailable) {
      return { target: "vision_briefing", reason: "describe/what's-in needs visual understanding (cloud vision)" };
    }
    return {
      target: "manual_fallback",
      reason: "describe/what's-in needs visual understanding; no cloud vision available (honest unsupported)"
    };
  }

  // 3) A required decision is missing → ask exactly one question.
  if (ctx.willAsk) {
    return { target: "clarify", reason: "a required decision is missing" };
  }

  // 4) Verbatim range / as-is merge → deterministic, no semantic planning.
  if (
    brief.intentKind === "extract_range" ||
    brief.output.outputType === "as_is_merge"
  ) {
    return { target: "deterministic", reason: "verbatim range / as-is merge needs no semantic planning" };
  }

  // 5) Semantic edit planning — prefer cloud, then local, then manual.
  if (ctx.cloudAvailable) {
    return { target: "cloud_planner", reason: "semantic planning via cloud planner" };
  }
  if (ctx.localPlannerAvailable) {
    return { target: "local_planner", reason: "cloud unavailable — planning on-device (text-only)" };
  }
  return {
    target: "manual_fallback",
    reason: "no planner available — offer manual/deterministic editing"
  };
}

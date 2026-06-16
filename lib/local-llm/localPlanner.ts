// =====================================================================
// lib/local-llm/localPlanner.ts
//
// TEXT-ONLY local planner built on the lazy WebLLM engine. This is the
// SECOND tier of the provider router:
//
//     cloud planner (/api/agent)  →  LOCAL WebLLM planner  →  manual
//
// It produces a small EditPlan (same shape the cloud planner emits) which is
// then run through the existing client pipeline — the in-browser scoring/render
// path is unchanged.
//
// VISION HONESTY: a small on-device text model cannot look at video frames.
// When the user's request is really a "describe / what's in the video" ask,
// return { kind: "unsupported" } before loading WebLLM so local-only mode shows
// a truthful message instead of the raw cloud-disabled provider error.
// =====================================================================

import type { EditPlan } from "@/lib/types";
import { normalizePlan } from "@/lib/plan/normalize";
import { extractJsonObject } from "@/lib/util/safeJson";
import { isWebGPUAvailable, localChatJson } from "./webllm";

/** Outcome of a local planning attempt. */
export type LocalPlanResult =
  | { kind: "plan"; plan: EditPlan; message: string }
  | { kind: "unsupported"; reason: string }
  | null; // engine unavailable / unparseable → caller falls back to manual

/** Compact, model-friendly planner prompt. Deliberately small so a ~1B
 *  instruct model can follow it and finish the JSON within the token cap. */
const LOCAL_PLANNER_SYSTEM = `You are an offline video-editing planner running on the user's device. You DO NOT see the video — you only read the user's text request and turn it into a short JSON edit plan for a highlight-reel pipeline.

Return ONE JSON object, no markdown, no commentary.

If the user is asking you to WATCH or DESCRIBE the video, identify objects/people, or say "what's in" / "what happens" in the footage, you CANNOT do that offline. In that case return exactly:
{"mode":"unsupported","reason":"vision"}

Otherwise return an edit plan:
{
  "mode":"plan",
  "message":"<one short friendly sentence>",
  "scenarios":[{"prompt":"<what should be on screen>"}],
  "signals":{"semantic":0.5,"motion":0.3,"saliency":0.2},
  "targetShortSeconds":30,
  "format":"vertical",
  "transition":"none"
}

Rules:
- scenarios: 1-4 items describing visible moments to keep. If the user just says "best parts"/"highlights" with no topic, use an empty scenarios array [] and set signals to {"semantic":0,"motion":0.6,"saliency":0.4}.
- format: "vertical" | "horizontal" | "square". Default "vertical" for shorts/reels/tiktok.
- Only include numbers the user actually stated (e.g. "30s"). Omit fields you are unsure about; defaults are applied for you.
- Never invent what is visually in the video. Describe only what the user asked for.`;

function buildUserPrompt(
  userRequest: string,
  ctx: { videoDurationSeconds?: number }
): string {
  const lines: string[] = [];
  if (typeof ctx.videoDurationSeconds === "number" && ctx.videoDurationSeconds > 0) {
    lines.push(`Video duration: ${ctx.videoDurationSeconds.toFixed(0)}s`);
  }
  lines.push(`User request: ${userRequest.slice(0, 500)}`);
  return lines.join("\n");
}

/** Raw shape we try to read out of the local model. */
interface LocalPlannerJson {
  mode?: string;
  reason?: string;
  message?: string;
  // plan fields may be nested under "plan" or live at the top level.
  plan?: unknown;
  scenarios?: unknown;
}

/**
 * Attempt to plan `userRequest` entirely on-device. Returns:
 *   - { kind: "plan" }        when a usable EditPlan was produced
 *   - { kind: "unsupported" } when the request needs vision the local model lacks
 *   - null                    when WebGPU is missing, the engine failed, or the
 *                             output couldn't be parsed (→ caller shows manual fallback)
 */
export async function tryLocalPlannerFallback(
  userRequest: string,
  ctx: { videoDurationSeconds?: number } = {}
): Promise<LocalPlanResult> {
  if (isLocalVisionRequest(userRequest)) {
    return { kind: "unsupported", reason: "vision" };
  }

  if (!isWebGPUAvailable()) return null;

  let raw: string;
  try {
    raw = await localChatJson(
      LOCAL_PLANNER_SYSTEM,
      buildUserPrompt(userRequest, ctx),
      { maxTokens: 1024, temperature: 0.3 }
    );
  } catch {
    // Engine load/generation failed — caller degrades to manual.
    return null;
  }

  const parsed = extractJsonObject<LocalPlannerJson>(raw);
  if (!parsed) return null;

  if (parsed.mode === "unsupported") {
    return {
      kind: "unsupported",
      reason: typeof parsed.reason === "string" ? parsed.reason : "vision"
    };
  }

  // Plan fields may be nested under `plan` or emitted at the top level.
  const planSource =
    parsed.plan && typeof parsed.plan === "object" ? parsed.plan : parsed;
  const norm = normalizePlan(planSource);
  if (!norm.plan) return null;

  const message =
    typeof parsed.message === "string" && parsed.message.trim()
      ? parsed.message.trim().slice(0, 200)
      : "Cloud AI was unavailable, so I planned this on your device. Heads up — local AI can't watch the video frames yet.";

  return { kind: "plan", plan: norm.plan, message };
}

function isLocalVisionRequest(userRequest: string): boolean {
  const text = userRequest.toLowerCase();
  return (
    /\b(describe|watch|see|identify|recognize|detect|analyse|analyze)\b/.test(text) &&
    /\b(video|clip|frame|footage|scene|screen)\b/.test(text)
  ) || /what('| i)?s in (this|the) (video|clip|footage)/.test(text) ||
    /what happens? in (this|the) (video|clip|footage)/.test(text);
}

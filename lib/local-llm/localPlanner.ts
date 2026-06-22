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
import {
  deriveActionableIntent,
  actionableIntentMessage
} from "@/lib/plan/deriveIntent";
import { buildConstraintGraph, isConstraintDriven } from "@/lib/constraints/graph";
import { splitExclusions } from "@/lib/intent/videoPromptInterpreter";
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

HOW TO REASON ABOUT THE REQUEST (think before you emit, but output ONLY the JSON):
- Read the WHOLE request as the description of a moment or scene the user wants, NOT a bag of keywords. "find the intense fight against the red boy with amazing combat" is ONE scene: an intense fight against a character called "Red Boy". It is NOT five separate searches.
- Write scenarios as natural visual descriptions of what the camera would show. Prefer ONE scenario that captures the scene. Use 2-3 ONLY when the user clearly lists distinct separate moments ("the cooking part AND the taste test"). Never emit one scenario per word.
- Keep multi-word names/entities together ("red boy", "boss fight", "final battle") — do not split them.
- IGNORE intensity/quality words (intense, amazing, epic, insane, brutal) and conversational words (more, again, please, detailed) when deciding WHAT to find — they change tone, not content. You may reflect the intensity in the "message", not in the search prompt.
- For action/fight/combat/chase/sports requests, weight motion higher: e.g. {"semantic":0.5,"motion":0.4,"saliency":0.1}. For calm/dialogue/scenery requests, weight semantic higher.

SPECIAL CASES:
- "best parts"/"highlights"/"make a reel" with NO concrete topic → empty scenarios array [] and signals {"semantic":0,"motion":0.6,"saliency":0.4}.
- A bare conversational follow-up with no new content to find ("more detailed", "explain", "why those") is NOT an edit. Return {"mode":"unsupported","reason":"vision"} only if it asks about footage; otherwise emit an empty-scenario best-parts plan and say in the message that you kept the current focus.

Rules:
- scenarios: 0-3 items. format: "vertical" | "horizontal" | "square" (default "vertical" for shorts/reels/tiktok).
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
  ctx: { videoDurationSeconds?: number; compiledPrompt?: string } = {}
): Promise<LocalPlanResult> {
  if (isLocalVisionRequest(userRequest)) {
    return { kind: "unsupported", reason: "vision" };
  }

  // v2.1 — When the agentic intake layer has compiled a clean, structured
  // brief for this turn, plan from THAT instead of the raw messy text. The
  // vision-honesty guard above still runs on the original request so a
  // "describe the video" ask is never mis-handled as an edit.
  const planningInput =
    typeof ctx.compiledPrompt === "string" && ctx.compiledPrompt.trim()
      ? ctx.compiledPrompt.trim()
      : userRequest;

  const quick = quickOfflinePlan(userRequest);

  // Trivial, unambiguous asks (why-questions, generic "best parts", a bare
  // "make a vertical reel") need no model reasoning — answer them instantly so
  // the user never waits on a model download. Everything DESCRIPTIVE (a real
  // scene/topic, e.g. "the intense fight against the red boy") is routed to the
  // on-device LLM below so the plan reflects real intent instead of token soup.
  if (quick && isInstantDeterministicCase(userRequest)) return quick;

  // Prefer the on-device LLM for descriptive requests: it reads the request as
  // one coherent scene (entity-aware) rather than splitting it into per-word
  // searches. On any failure we fall back to the cleaned deterministic plan.
  if (isWebGPUAvailable()) {
    try {
      const raw = await localChatJson(
        LOCAL_PLANNER_SYSTEM,
        buildUserPrompt(planningInput, ctx),
        { maxTokens: 1024, temperature: 0.3 }
      );
      const parsed = extractJsonObject<LocalPlannerJson>(raw);
      if (parsed) {
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
        if (norm.plan) {
          const message =
            typeof parsed.message === "string" && parsed.message.trim()
              ? parsed.message.trim().slice(0, 200)
              : "Planned this on your device. Heads up \u2014 I can't watch the video frames locally yet, so I went by your description.";
          return { kind: "plan", plan: norm.plan, message };
        }
      }
      // Unparseable / empty plan → fall through to the deterministic plan.
    } catch {
      // Engine load/generation failed → fall through to the deterministic plan.
    }
  }

  // Deterministic safety net: no WebGPU, or the local model failed/!parsed.
  // Reuses the SAME cleaned intent interpreter, so even this path no longer
  // emits keyword soup.
  return quick;
}

function isLocalVisionRequest(userRequest: string): boolean {
  // Fix the common "watch" typos first so "wath my video" is still recognised
  // as a (vision) describe request rather than an edit for "wath moments".
  const text = userRequest
    .toLowerCase()
    .replace(/\b(?:wath|wacth|wathc|wtach|waatch|watchh)\b/g, "watch");
  return (
    /\b(describe|watch|see|identify|recognize|detect|analyse|analyze)\b/.test(text) &&
    /\b(video|clip|frame|footage|scene|screen)\b/.test(text)
  ) || /what('| i)?s in (this|the) (video|clip|footage)/.test(text) ||
    /what happens? in (this|the) (video|clip|footage)/.test(text);
}

/**
 * True for requests that need NO model reasoning and can be answered instantly
 * and deterministically:
 *   - "why did you pick these" explanations,
 *   - generic "best parts / highlights / make a reel" (pure visual-interest),
 *   - a bare "make a vertical reel" with no concrete subject.
 * Everything else (a concrete described scene/topic) is deferred to the
 * on-device LLM so it can reason about the whole request as one scene.
 */
function isInstantDeterministicCase(rawRequest: string): boolean {
  const text = (rawRequest || "").toLowerCase();
  const asksWhy =
    /\bwhy\b.*\b(pick|picked|choose|chosen|select|selected)\b/.test(text) ||
    /\bwhy\b.*\bclips?\b/.test(text);
  if (asksWhy) return true;

  const intent = deriveActionableIntent(rawRequest, {});
  if (intent.genericBestParts) return true;

  const explicitVertical =
    /\b(vertical|reels?|shorts?|tiktok|9:16)\b/.test(text) &&
    /\b(make|create|turn|convert|build)\b/.test(text);
  if (explicitVertical && intent.scenarioLabels.length === 0) return true;

  return false;
}

/**
 * Deterministic, offline quick-plan. Reuses the SAME intent interpreter as
 * the cloud fallback (`deriveActionableIntent`) — no duplicate keyword logic —
 * and compiles a CONSTRAINT-FIRST plan so an offline "only lab view" request
 * is hard-gated exactly like the online path. Focus/intent is always read from
 * the user's RAW words (never a compiled brief string), which is what produced
 * the earlier garbled "output type: …" message.
 */
function quickOfflinePlan(rawRequest: string): LocalPlanResult {
  const text = (rawRequest || "").toLowerCase();
  const asksWhy =
    /\bwhy\b.*\b(pick|picked|choose|chosen|select|selected)\b/.test(text) ||
    /\bwhy\b.*\bclips?\b/.test(text);

  if (asksWhy) {
    return {
      kind: "plan",
      // A why-question doesn't change the plan; surface an honest explanation.
      plan: fallbackVisualInterestPlan(),
      message:
        "Those clips were picked by local scoring because they ranked higher for motion and visual saliency. Detailed scene reasons need the video-memory tree wiring next."
    };
  }

  const intent = deriveActionableIntent(rawRequest, {});
  const wantsVertical =
    /\b(vertical|reels?|shorts?|tiktok|9:16)\b/.test(text) &&
    /\b(make|create|turn|convert|build)\b/.test(text);

  // Nothing actionable and no clear "make a vertical reel" → let WebLLM /
  // manual handle it rather than guessing.
  if (!intent.actionable && !wantsVertical) return null;

  const hasFocus = intent.scenarioLabels.length > 0 && !intent.genericBestParts;
  const scenarios = hasFocus
    ? intent.scenarioLabels.slice(0, 4).map((prompt) => ({ prompt }))
    : [];
  const signals = hasFocus
    ? { semantic: 0.65, motion: 0.2, saliency: 0.15 }
    : { semantic: 0, motion: 0.6, saliency: 0.4 };

  const norm = normalizePlan({
    scenarios,
    signals,
    selectionStrategy: "best",
    format: intent.format,
    transition: "none",
    userSpecifiedDuration: intent.userSpecifiedDuration,
    ...(intent.targetSeconds ? { targetShortSeconds: intent.targetSeconds } : {}),
    rationale: hasFocus
      ? `Offline plan preserving the user's requested focus: ${intent.rawFocus ?? ""}.`
      : "Offline plan using motion and saliency."
  });
  if (!norm.plan) return null;

  // CONSTRAINT-FIRST offline: compile the same constraint graph the cloud
  // path would, so "only X" hard-filters before scoring even with no network.
  const excludeSubjects = splitExclusions(rawRequest).exclusions;
  const { graph, excludeScenarios } = buildConstraintGraph({
    goal: "create short video",
    scenarios: norm.plan.scenarios.map((s) => ({ id: s.id, prompt: s.prompt })),
    exclusiveOnly: intent.exclusiveOnly,
    excludeSubjects,
    genericBestParts: intent.genericBestParts,
    highlightRequested: intent.genericBestParts,
    targetSeconds: intent.targetSeconds ?? null,
    userSpecifiedDuration: intent.userSpecifiedDuration
  });
  for (const ex of excludeScenarios) {
    if (!norm.plan.scenarios.some((s) => s.id === ex.id)) {
      norm.plan.scenarios.push({ id: ex.id, prompt: ex.prompt, weight: 0 });
      norm.plan.labelWeights[ex.id] = 0;
    }
  }
  if (isConstraintDriven(graph) || graph.highlightMode) {
    norm.plan.constraints = graph;
  }

  const message = intent.actionable
    ? actionableIntentMessage(intent, true)
    : "I\u2019ll make a vertical reel locally using the best motion and saliency moments.";

  return { kind: "plan", plan: norm.plan, message };
}

/** A bare motion+saliency plan used for "why did you pick these" answers. */
function fallbackVisualInterestPlan(): EditPlan {
  const norm = normalizePlan({
    scenarios: [],
    signals: { semantic: 0, motion: 0.6, saliency: 0.4 },
    selectionStrategy: "best",
    format: "vertical",
    transition: "none",
    userSpecifiedDuration: false
  });
  // normalizePlan always succeeds for an empty-scenario visual-interest plan.
  return norm.plan as EditPlan;
}

import { NextRequest, NextResponse } from "next/server";
import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import { sessionOptions, type SessionData } from "@/lib/session/cookie";
import { checkAllLimits } from "@/lib/ratelimit";
import { hasAnyChatProvider } from "@/lib/env";
import { isTransientError } from "@/lib/providers/gemini";
import { cloudPlannerJson } from "@/lib/providers/cloud";
import {
  PLANNER_SYSTEM_PROMPT,
  buildPlannerUserPrompt
} from "@/lib/plan/prompt";
import { normalizePlan, normalizePlanPatch } from "@/lib/plan/normalize";
import { normalizeComposePlan } from "@/lib/plan/composeNormalize";
import {
  deriveComposeIntent,
  type ComposeIntentResult
} from "@/lib/plan/composeIntent";
import {
  deriveActionableIntent,
  actionableIntentMessage,
  type ActionableIntent
} from "@/lib/plan/deriveIntent";
import { mergePlan } from "@/lib/plan/merge";
import { extractFacts } from "@/lib/memory/extract";
import { decayFacts, mergeFacts } from "@/lib/memory/store";
import { extractJsonObject } from "@/lib/util/safeJson";
import { newId } from "@/lib/util/id";
import { CONVERSATION, PLAN_DEFAULTS, RATE_LIMITS, SIGNAL_DEFAULTS, SYNTH_PLAN } from "@/lib/config";
import type {
  AgentRequest,
  AgentResponse,
  ChatMessage,
  ClarifyQuestion,
  EditOperation,
  EditPlan,
  ExtractRange,
  InferredField,
  IntentMode,
  MemoryFact,
  PlanPatch,
  RateLimitDecision,
  SessionMemory,
  UserTier
} from "@/lib/types";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasAnyChatProvider()) {
    return NextResponse.json<AgentResponse>(
      {
        mode: "error",
        error: "No chat provider configured. Set OPENROUTER_API_KEY, GEMINI_API_KEY, or GROQ_API_KEY."
      },
      { status: 503 }
    );
  }

  const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
  if (!session.sid) {
    session.sid = newId("u");
    session.createdAt = Date.now();
    await session.save();
  }

  // ---- Layers 2/3 rate check (Layer 1 already ran in middleware) -----
  // No `provider` is passed: the planner goes through the multi-provider
  // dispatcher (OpenRouter → Gemini → Groq), which skips circuit-open
  // providers itself. Passing a provider here would let an open primary
  // circuit 503 the request before fallback could run.
  const rl = await checkAllLimits({
    sid: session.sid,
    scope: "agent",
    consumesLlm: true
  });
  if (!rl.allowed) {
    return rateLimitResponse(rl);
  }
  const quotaWarning = buildQuotaWarning(rl);

  // ---- Parse body ----------------------------------------------------
  let body: AgentRequest;
  try {
    body = (await req.json()) as AgentRequest;
  } catch {
    return NextResponse.json<AgentResponse>(
      { mode: "error", error: "Invalid JSON body" },
      { status: 400 }
    );
  }
  const validation = validateRequest(body);
  if (validation) {
    return NextResponse.json<AgentResponse>(
      { mode: "error", error: validation },
      { status: 400 }
    );
  }
  const messages = body.messages;
  const latest = messages[messages.length - 1];
  const userText = latest.content;

  // ---- Read persistent memory facts (v1.7.0) -------------------------
  // We decay everyone's facts once per turn — this keeps low-confidence
  // legacy facts from drifting forward forever. Decay is small (-0.02)
  // so reinforced facts (those the planner re-emits) easily stay above
  // the eviction floor.
  const priorFacts = decayFacts(session.facts ?? []);

  // ---- Build the planner prompt -------------------------------------
  // No regex / keyword heuristics on the server. The LLM does ALL intent
  // understanding from the user's words + the structured context below.
  const userPrompt = buildPlannerUserPrompt({
    messages,
    currentPlan: body.currentPlan ?? null,
    videoMeta: body.videoMeta,
    videoLibrary: body.videoLibrary,
    activeSourceId: body.activeSourceId,
    highlightsCount: body.highlightsCount,
    selectedClipId: body.selectedClipId,
    highlights: body.timelineClips,
    memory: body.memory,
    facts: priorFacts,
    // v1.7.2 — the client already sends the most recent briefing's best
    // parts; thread them into the prompt so the planner can (a) emit
    // `mode: "promote"` for "clip those" / "use the second one" and
    // (b) GROUND a fresh briefing follow-up ("show me all ingredient
    // prep shots") against what the briefing actually found, instead of
    // falling back to the "what should the short be about?" clarify.
    // Without this line the "Last briefing best parts" block in
    // buildPlannerUserPrompt was always rendered empty.
    lastBriefing: body.lastBriefing,
    recentActivity:
      typeof body.recentActivity === "string" ? body.recentActivity : undefined
  });

  // ---- Call the cloud planner via the provider dispatcher ------------
  // Provider order: OpenRouter → Gemini → Groq (see lib/providers/cloud.ts +
  // CLOUD_PROVIDER_ORDER). The dispatcher records each provider's circuit
  // success/failure and falls back on failure, so an OpenRouter outage (or
  // no OpenRouter key) degrades to the existing Gemini/Groq flow unchanged.
  const warnings: string[] = [];
  let raw: string;
  try {
    const result = await cloudPlannerJson(PLANNER_SYSTEM_PROMPT, userPrompt);
    raw = result.raw;
    if (result.usedFallback) {
      warnings.push(
        `Primary model provider unavailable; used ${result.provider} fallback.`
      );
    }
  } catch (e2) {
    const transient = isTransientError(e2);
    // v1.8.1 — multi-source compose has priority even when the cloud planner
    // is down. A 504/timeout must not drop "combat in the first video and
    // cutscene in the second" to a single-source plan. Detect compose first.
    const composeIntent = deriveComposeIntent(userText);
    if (composeIntent) {
      return buildComposeResponse(
        composeIntent,
        body,
        [
          ...warnings,
          "Cloud planner was momentarily unavailable \u2014 used a quick local interpretation of your request."
        ],
        quotaWarning
      );
    }
    // v1.9.x — A planner failure (504 / 503 / timeout / transient) must NOT
    // automatically kill the turn. If the user's request is already
    // actionable (a content focus, a duration, or an "only/alone" scope),
    // run the deterministic intent fallback and PROCEED with a synthesized
    // plan instead of dead-ending on an error. Only when the prompt is truly
    // not actionable do we surface the transient planner error.
    const intent = deriveActionableIntent(userText, {
      hasVideo: hasVideoSource(body)
    });
    if (intent.actionable) {
      const synth = synthesizeVaguePlan({
        userText,
        currentPlan: body.currentPlan ?? null,
        memory: body.memory,
        intent
      });
      return NextResponse.json<AgentResponse>({
        mode: "plan",
        plan: synth,
        // Auto-run only when a source exists; otherwise the message asks for
        // an upload and the client shows the plan pending.
        ...(hasVideoSource(body) ? { autoRun: true } : {}),
        message: actionableIntentMessage(intent, hasVideoSource(body)),
        userTier: "novice",
        inferred: [],
        warnings: [
          ...warnings,
          "Cloud planner was momentarily unavailable \u2014 used a quick local interpretation of your request."
        ],
        ...(quotaWarning ? { quotaWarning } : {})
      });
    }
    return NextResponse.json<AgentResponse>(
      {
        mode: "error",
        error: transient
          ? "The chat model is temporarily overloaded. Please try again in a few seconds."
          : `Planner failed: ${(e2 as Error).message}`,
        transient
      },
      { status: transient ? 503 : 502 }
    );
  }

  // ---- Parse LLM JSON ------------------------------------------------
  const parsed = extractJsonObject<Record<string, unknown>>(raw);
  if (!parsed) {
    return NextResponse.json<AgentResponse>(
      { mode: "error", error: "Planner returned invalid JSON." },
      { status: 502 }
    );
  }

  // v1.5.2 — defensively resolve the mode. If the LLM omitted or
  // mistyped the mode field, infer it from the JSON envelope it DID
  // send (extractRange present → "extract", questions present → "clarify",
  // etc.). This NEVER inspects the user's text — only the model's own
  // structured output — so the "no regex/keyword heuristics on user
  // input" rule still holds. Picking a reasonable mode beats crashing.
  const mode: IntentMode = resolveMode(parsed);
  const userTier = normalizeUserTier(parsed.userTier);

  // v1.7.0 — extract candidate memory facts from THIS turn's planner
  // output and merge them into the session store. We do this once,
  // up-front, so every mode-specific branch below benefits without
  // having to remember to call it. The extracted facts go in
  // session.facts; the cookie save happens at the end.
  const freshFacts = extractFacts(parsed);
  const newFacts: MemoryFact[] =
    freshFacts.length > 0 ? mergeFacts(priorFacts, freshFacts) : priorFacts;
  // Only schedule a cookie save when something actually changed — this
  // avoids hot-path Set-Cookie headers on every turn.
  const factsChanged =
    freshFacts.length > 0 || newFacts.length !== (session.facts ?? []).length;
  if (factsChanged) {
    session.facts = newFacts;
    // Fire-and-forget; the response can ship before the save completes.
    void session.save().catch(() => {});
  }

  // ---- COMPOSE PRIORITY OVERRIDE (v1.8.1) ----------------------------
  // Deterministic multi-source compose has PRIORITY over the cloud
  // planner's own choice (priority #1). The runtime bug was that a clear
  // request like "pick combat in the first video and the cutscene in the
  // second and make it transition" got classified as a single-source plan
  // and then the generic fallback built junk scenarios ("pick / first /
  // transition moments"). When the user's text CLEARLY references picks
  // from MORE THAN ONE source (high confidence) and the planner did not
  // itself choose compose, we answer with compose here — before any
  // single-source handling. Lower-confidence signals are handled only in
  // the fallback sites below (planner failure / clarify / unusable plan),
  // so a valid single-source plan is never hijacked.
  if (mode !== "compose") {
    const composeIntent = deriveComposeIntent(userText);
    if (composeIntent && composeIntent.confidence === "high") {
      return buildComposeResponse(composeIntent, body, warnings, quotaWarning);
    }
  }

  // ---- ACKNOWLEDGE (v1.5.2) -----------------------------------------
  // Context-update turn. The user told us a fact about the footage
  // ("there's a defeat title", "this is 4K", "audio is bad", etc.).
  // We confirm we heard it and leave the existing plan / clip state
  // untouched. The pipeline does NOT run on this turn.
  if (mode === "acknowledge") {
    const inferred = normalizeInferred(parsed.inferred);
    return NextResponse.json<AgentResponse>({
      mode: "acknowledge",
      message: stringOr(parsed.message, "Got it — I'll keep that in mind."),
      inferred,
      warnings,
      ...(quotaWarning ? { quotaWarning } : {})
    });
  }

  // ---- EDIT (v1.6.1) -------------------------------------------------
  // Direct timeline mutation. The LLM emits a list of structured ops
  // ({ kind: "trim_first", seconds: 60 }, { kind: "drop_range", ... })
  // and the client applies them in order. No pipeline run, no scoring.
  if (mode === "edit") {
    const operations = normalizeEditOperations(parsed.operations);
    if (operations.length === 0) {
      // The LLM said edit but couldn't produce a valid op. Don't crash —
      // ask one focused question so the user can try again.
      return NextResponse.json<AgentResponse>({
        mode: "clarify",
        message:
          "I picked up the edit intent but the operation didn't parse \u2014 mind rephrasing? Examples: \"trim first 30 seconds\", \"drop 0:30 to 0:45\", \"split this clip\".",
        questions: [
          {
            id: "edit_op",
            prompt: "What kind of edit?",
            suggestions: [
              "Trim first 30 seconds",
              "Trim last 30 seconds",
              "Drop 0:30 to 0:45",
              "Split this clip",
              "Reset and start over"
            ],
            kind: "single-choice"
          }
        ],
        warnings,
        ...(quotaWarning ? { quotaWarning } : {})
      });
    }
    const inferred = normalizeInferred(parsed.inferred);
    return NextResponse.json<AgentResponse>({
      mode: "edit",
      operations,
      message: stringOr(parsed.message, "Done."),
      inferred,
      warnings,
      ...(quotaWarning ? { quotaWarning } : {})
    });
  }

  // ---- DESCRIBE (v1.6.4) --------------------------------------------
  // Clip-level Q&A. The LLM tagged this turn as a question about a
  // specific clip; we forward the (target, question) tuple to the
  // client. The client extracts ~6 frames from the target's range
  // and calls /api/vision/clip — that's where the actual visual
  // analysis happens. The agent route just brokers the intent.
  if (mode === "describe") {
    const target = normalizeDescribeTarget(parsed.target);
    const question =
      typeof parsed.question === "string" && parsed.question.trim()
        ? parsed.question.trim().slice(0, 500)
        : (userText.length > 0 ? userText.slice(0, 500) : "");
    if (!target || !question) {
      // Couldn't resolve the clip target or the question. Ask the
      // user to point at a clip so we don't burn a vision call on
      // ambiguous input.
      return NextResponse.json<AgentResponse>({
        mode: "clarify",
        message:
          "Tell me which clip to look at \u2014 select one on the timeline, or name it (\u201cclip 2\u201d / \u201cthe selected clip\u201d).",
        questions: [
          {
            id: "describe_target",
            prompt: "Which clip should I look at?",
            suggestions: [
              "The selected clip",
              "Clip 1",
              "Clip 2",
              "Describe the whole short"
            ],
            kind: "single-choice"
          }
        ],
        warnings,
        ...(quotaWarning ? { quotaWarning } : {})
      });
    }
    const inferred = normalizeInferred(parsed.inferred);
    return NextResponse.json<AgentResponse>({
      mode: "describe",
      target,
      question,
      message: stringOr(parsed.message, "Looking at that clip\u2026"),
      inferred,
      warnings,
      ...(quotaWarning ? { quotaWarning } : {})
    });
  }

  // ---- BRIEFING (v1.7.0) --------------------------------------------
  // The user wants a structured *description* of the video — overview
  // + best parts + suggested follow-ups — without any rendering. The
  // planner classifies the intent and emits a sample plan; the client
  // does the actual frame extraction and POSTs to /api/agent/briefing
  // for the vision call. This route just brokers the intent + sample
  // plan + waiting message. The pipeline does NOT run.
  if (mode === "briefing") {
    const samplePlan = normalizeBriefingSamplePlan(parsed.samplePlan);
    const question =
      typeof parsed.question === "string" && parsed.question.trim()
        ? parsed.question.trim().slice(0, 500)
        : userText.slice(0, 500);

    if (!question) {
      // No question to forward. Fall back to clarify rather than
      // burning a vision call on an empty prompt.
      return NextResponse.json<AgentResponse>({
        mode: "clarify",
        message:
          "Tell me what you'd like me to look for, or just say 'describe the whole video'.",
        questions: [
          {
            id: "briefing_intent",
            prompt: "What should I focus on?",
            suggestions: [
              "Describe the whole video",
              "Tell me the best parts",
              "Just summarize it"
            ],
            kind: "single-choice"
          }
        ],
        warnings,
        ...(quotaWarning ? { quotaWarning } : {})
      });
    }
    const inferred = normalizeInferred(parsed.inferred);
    return NextResponse.json<AgentResponse>({
      mode: "briefing",
      question,
      samplePlan,
      message: stringOr(parsed.message, "Watching the whole thing now\u2026"),
      inferred,
      warnings,
      ...(quotaWarning ? { quotaWarning } : {})
    });
  }

  // ---- MERGE (v1.7.4) ------------------------------------------------
  // The user wants the whole videos concatenated as-is — no scoring,
  // no clipping, no editing. We forward the (sourceIds, transition,
  // format, op) envelope to the client; the client converts each
  // requested source into a full-duration Highlight and renders.
  // No vision / SigLIP / planner-pipeline work happens here.
  if (mode === "merge") {
    const sourceIds = Array.isArray(parsed.sourceIds)
      ? parsed.sourceIds
          .filter(
            (x): x is string => typeof x === "string" && x.trim().length > 0
          )
          .map((s) => s.trim().slice(0, 64))
          .slice(0, 16)
      : undefined;
    const transition: "none" | "fade" | "crossfade" =
      parsed.transition === "fade"
        ? "fade"
        : parsed.transition === "crossfade"
          ? "crossfade"
          : "none";
    const format =
      parsed.format === "vertical" ||
      parsed.format === "horizontal" ||
      parsed.format === "square"
        ? parsed.format
        : undefined;
    const op = parsed.op === "append" ? "append" : ("replace" as const);
    const inferred = normalizeInferred(parsed.inferred);
    return NextResponse.json<AgentResponse>({
      mode: "merge",
      ...(sourceIds && sourceIds.length > 0 ? { sourceIds } : {}),
      transition,
      ...(format ? { format } : {}),
      op,
      message: stringOr(parsed.message, "Merging the videos as-is."),
      inferred,
      warnings,
      ...(quotaWarning ? { quotaWarning } : {})
    });
  }

  // ---- COMPOSE (v1.8.0) ----------------------------------------------
  // Multi-source montage. The user referenced clips from MORE THAN ONE
  // uploaded video and asked to combine them ("combat in the first video
  // and the cutscene in the second, make it transition"). Unlike `merge`
  // (whole videos, no scoring) and `plan` (one fused reel across the
  // selected library), compose keeps each source's pick SEPARATE and
  // arranges them in a user-controlled order with transitions.
  //
  // The route only brokers + sanitises the envelope; the CLIENT resolves
  // each source ref against the live library and runs the REAL per-source
  // vision pipeline. No frames, scoring, or vision happen here.
  if (mode === "compose") {
    const compose = normalizeComposePlan(
      parsed.compose && typeof parsed.compose === "object"
        ? parsed.compose
        : parsed
    );
    if (!compose) {
      // The LLM tagged compose but didn't give usable per-source picks.
      // Ask one focused question instead of crashing.
      return NextResponse.json<AgentResponse>({
        mode: "clarify",
        message:
          "Tell me which moments from which videos to combine \u2014 e.g. \u201ccombat from the first video and the cutscene from the second\u201d.",
        questions: [
          {
            id: "compose_sources",
            prompt: "Which videos and moments should I combine?",
            suggestions: [
              "Combat from the first, cutscene from the second",
              "Intro from video 1, funny part from video 2",
              "Just merge the whole videos"
            ],
            kind: "single-choice"
          }
        ],
        warnings,
        ...(quotaWarning ? { quotaWarning } : {})
      });
    }
    const inferred = normalizeInferred(parsed.inferred);
    return NextResponse.json<AgentResponse>({
      mode: "compose",
      compose,
      ...(hasVideoSource(body) ? { autoRun: true } : {}),
      message: stringOr(
        parsed.message,
        "Building a combined montage from your videos."
      ),
      inferred,
      warnings,
      ...(quotaWarning ? { quotaWarning } : {})
    });
  }

  // ---- PROMOTE (v1.7.2) ----------------------------------------------
  // The user wants the briefing's already-curated best parts to become
  // actual clips on the timeline. The briefing's vision call has
  // already pinned exact (start, end) for each best part; this mode
  // does no new analysis — it just brokers the intent + sanitised
  // partIds/targetSeconds/op envelope to the client. The client owns
  // the lastBriefing slot and the conversion via promoteBriefingParts.
  //
  // We never validate partIds against the briefing here on the server
  // because the briefing lives client-side; mismatched ids degrade
  // gracefully on the client (which warns the user instead of
  // crashing).
  if (mode === "promote") {
    const partIds = Array.isArray(parsed.partIds)
      ? parsed.partIds
          .filter(
            (x): x is string => typeof x === "string" && x.trim().length > 0
          )
          .map((s) => s.trim().slice(0, 64))
          .slice(0, 12)
      : undefined;
    const targetSeconds =
      typeof parsed.targetSeconds === "number" &&
      Number.isFinite(parsed.targetSeconds) &&
      parsed.targetSeconds > 0
        ? Math.min(600, Math.max(2, parsed.targetSeconds))
        : undefined;
    const op =
      parsed.op === "replace" ? "replace" : ("append" as const);
    const inferred = normalizeInferred(parsed.inferred);
    return NextResponse.json<AgentResponse>({
      mode: "promote",
      ...(partIds && partIds.length > 0 ? { partIds } : {}),
      ...(typeof targetSeconds === "number" ? { targetSeconds } : {}),
      op,
      message: stringOr(
        parsed.message,
        op === "replace"
          ? "Using those briefing moments instead."
          : "Adding those briefing moments to the timeline."
      ),
      inferred,
      warnings,
      ...(quotaWarning ? { quotaWarning } : {})
    });
  }

  // ---- EXTRACT (v1.5.0) ---------------------------------------------
  // Verbatim time-slice mode. No scoring, no scenarios required. The
  // pipeline emits exactly one Highlight for the requested range.
  if (mode === "extract") {
    const range = normalizeExtractRangeForResponse(parsed.extractRange);
    if (!range) {
      // The LLM said extract but didn't give a usable range — fall back
      // to clarify so we don't silently slice the wrong window.
      return NextResponse.json<AgentResponse>({
        mode: "clarify",
        message: "Tell me which seconds to grab — first / last / or a range.",
        questions: [
          {
            id: "range",
            prompt: "Which part of the video?",
            suggestions: [
              "First 30 seconds",
              "First minute",
              "Last 60 seconds",
              "From 0:30 to 1:30"
            ],
            kind: "single-choice"
          }
        ],
        warnings,
        ...(quotaWarning ? { quotaWarning } : {})
      });
    }
    const inferred = normalizeInferred(parsed.inferred);
    return NextResponse.json<AgentResponse>({
      mode: "extract",
      extractRange: range,
      ...(normalizeTimelineOp(parsed.op) ? { op: normalizeTimelineOp(parsed.op) } : {}),
      message: stringOr(parsed.message, "Grabbing that exact slice."),
      inferred,
      warnings,
      ...(quotaWarning ? { quotaWarning } : {})
    });
  }

  // ---- CLARIFY -------------------------------------------------------
  if (mode === "clarify") {
    // v1.8.1 — multi-source compose takes priority over a clarify/vague-plan
    // fallback. If the planner punted to clarify but the text clearly asks to
    // combine picks from multiple sources, compose it instead of asking a
    // generic topic question.
    const composeIntent = deriveComposeIntent(userText);
    if (composeIntent) {
      return buildComposeResponse(composeIntent, body, warnings, quotaWarning);
    }
    // v1.6.2 — anti-loop safety net. If the immediately-previous
    // assistant turn was ALSO a clarify (the LLM is stuck asking the
    // same thing twice despite the prompt rule), we treat the user's
    // reply as a topic answer and synthesize a vague plan. We use the
    // user's literal text as the scenario prompt so SigLIP scores
    // against it; if the text is too vague to be useful we fall back
    // to a motion+saliency plan that picks visually busy moments
    // without the semantic pass.
    //
    // This NEVER inspects the user message for keywords — it only
    // checks our own prior turn shape. The user's text just becomes
    // the scenario verbatim. No regex, no keyword classification.
    // v1.7.13 — mirror the plan/moment branch's deterministic safety net
    // here. We synthesize a grounded plan instead of asking
    // "what should the short be about?" when EITHER:
    //   (a) the previous assistant turn was a clarify (the original
    //       anti-loop guard), OR
    //   (b) a briefing is in scope (body.lastBriefing has best parts) AND
    //       the user gave a non-empty request. After a briefing the app
    //       already knows the video's subject and follow-up chips always
    //       carry a concrete topic, so re-asking is never correct — even
    //       when the LLM itself returned mode:"clarify" directly.
    // Only inspects our own prior turn shape + briefing presence; never
    // keyword-matches the user's text.
    const previousAssistant = findPreviousAssistant(messages);
    const previousWasClarify = looksLikeClarify(previousAssistant);
    const hasBriefingContext =
      !!body.lastBriefing &&
      Array.isArray(body.lastBriefing.bestParts) &&
      body.lastBriefing.bestParts.length > 0;
    const hasUsableTopic = userText.trim().length > 0;
    if (previousWasClarify || (hasBriefingContext && hasUsableTopic)) {
      const synth = synthesizeVaguePlan({
        userText,
        currentPlan: body.currentPlan ?? null,
        memory: body.memory,
        lastBriefing: hasBriefingContext ? body.lastBriefing : undefined
      });
      return NextResponse.json<AgentResponse>({
        mode: "plan",
        plan: synth,
        message:
          synth.scenarios.length > 0
            ? `On it \u2014 ${userText.trim().slice(0, 60)}.`
            : "Picking the visually richest moments \u2014 just give me a sec.",
        userTier: "novice",
        inferred: [],
        warnings,
        ...(quotaWarning ? { quotaWarning } : {})
      });
    }

    // v1.9.x — Before asking anything, check whether the user's text is
    // already actionable (content focus / duration / "only" scope). If so,
    // PROCEED with a synthesized plan rather than asking for a topic the
    // user effectively gave. This is what turns "i need a ingredient part
    // alone for 1min" into a 60s ingredient-only plan instead of a clarify.
    const clarifyIntent = deriveActionableIntent(userText, {
      hasVideo: hasVideoSource(body)
    });
    if (clarifyIntent.actionable) {
      const synth = synthesizeVaguePlan({
        userText,
        currentPlan: body.currentPlan ?? null,
        memory: body.memory,
        intent: clarifyIntent
      });
      return NextResponse.json<AgentResponse>({
        mode: "plan",
        plan: synth,
        ...(hasVideoSource(body) ? { autoRun: true } : {}),
        message: actionableIntentMessage(clarifyIntent, hasVideoSource(body)),
        userTier: "novice",
        inferred: [],
        warnings,
        ...(quotaWarning ? { quotaWarning } : {})
      });
    }

    const questions = normalizeClarifyQuestions(parsed.questions);
    if (questions.length === 0) {
      questions.push(
        defaultClarifyQuestion(body.currentPlan ?? null, clarifyContext(body))
      );
    }
    return NextResponse.json<AgentResponse>({
      mode: "clarify",
      message:
        typeof parsed.message === "string" && parsed.message.trim()
          ? cleanMessage(parsed.message.trim()) || dynamicClarifyMessage(body)
          : dynamicClarifyMessage(body),
      questions,
      warnings,
      ...(quotaWarning ? { quotaWarning } : {})
    });
  }

  // ---- PLAN / MOMENT -------------------------------------------------
  if (mode === "plan" || mode === "moment") {
    const buildResult = resolvePlan({
      mode,
      parsed,
      currentPlan: body.currentPlan ?? null,
      warnings
    });
    if (!buildResult.ok) {
      // v1.8.1 — multi-source compose priority. The planner said plan/moment
      // but produced no usable scenarios; if the text is a clear multi-source
      // montage request, compose it instead of synthesizing a single-source
      // plan from the raw words.
      const composeIntent = deriveComposeIntent(userText);
      if (composeIntent) {
        return buildComposeResponse(composeIntent, body, warnings, quotaWarning);
      }
      // v1.7.12 — deterministic safety net so product-critical UX does
      // not depend only on the LLM emitting a valid plan.
      //
      // The LLM tagged this turn as plan/moment but failed to emit usable
      // scenarios, so resolvePlan bailed. We synthesize a plan from the
      // user's own words (instead of re-asking "what should the short be
      // about?") in EITHER of these cases:
      //
      //   (a) the previous assistant turn was a clarify — the original
      //       anti-loop guard, so a user who already answered isn't asked
      //       the same thing forever; OR
      //   (b) a briefing is in scope (body.lastBriefing has best parts)
      //       AND the user gave a non-empty request. After a briefing the
      //       app already knows the video's subject, and follow-up chips
      //       ("Show all ingredient preparation clips") always carry a
      //       concrete topic — so re-asking is never correct.
      //
      // This only inspects our OWN prior turn shape + the presence of a
      // briefing; it never keyword-matches the user's text. The synthesis
      // turns their literal words into a scenario the pipeline can score.
      const previousAssistant = findPreviousAssistant(messages);
      const previousWasClarify = looksLikeClarify(previousAssistant);
      const hasBriefingContext =
        !!body.lastBriefing &&
        Array.isArray(body.lastBriefing.bestParts) &&
        body.lastBriefing.bestParts.length > 0;
      const hasUsableTopic = userText.trim().length > 0;

      if (previousWasClarify || (hasBriefingContext && hasUsableTopic)) {
        const synth = synthesizeVaguePlan({
          userText,
          currentPlan: body.currentPlan ?? null,
          memory: body.memory,
          // Pass the briefing so the synthesizer can ground concrete
          // scenario prompts in the video's actual subject.
          lastBriefing: hasBriefingContext ? body.lastBriefing : undefined
        });
        const timelineOp = normalizeTimelineOp(parsed.op);
        return NextResponse.json<AgentResponse>({
          mode: "plan",
          plan: synth,
          ...(timelineOp ? { op: timelineOp } : {}),
          message:
            synth.scenarios.length > 0
              ? `On it \u2014 ${userText.trim().slice(0, 60)}.`
              : "Picking the visually richest moments \u2014 just give me a sec.",
          userTier: "novice",
          inferred: [],
          warnings,
          ...(quotaWarning ? { quotaWarning } : {})
        });
      }

      // v1.9.x — Agentic fallback: the LLM failed to emit a usable plan, but
      // the user's text may already carry enough intent (a content focus,
      // a duration, an "only/alone" scope). Derive it and PROCEED instead of
      // dead-ending on the old static "what should the short be about?".
      // Only when there's genuinely no actionable focus do we ask one
      // context-aware question (built dynamically below).
      const intent = deriveActionableIntent(userText, { hasVideo: hasVideoSource(body) });
      if (intent.actionable) {
        const synth = synthesizeVaguePlan({
          userText,
          currentPlan: body.currentPlan ?? null,
          memory: body.memory,
          intent
        });
        const timelineOp = normalizeTimelineOp(parsed.op);
        return NextResponse.json<AgentResponse>({
          mode: "plan",
          plan: synth,
          ...(timelineOp ? { op: timelineOp } : {}),
          ...(hasVideoSource(body) ? { autoRun: true } : {}),
          message: actionableIntentMessage(intent, hasVideoSource(body)),
          userTier: "novice",
          inferred: [],
          warnings,
          ...(quotaWarning ? { quotaWarning } : {})
        });
      }
      return NextResponse.json<AgentResponse>({
        mode: "clarify",
        message: dynamicClarifyMessage(body),
        questions: missingFieldsToQuestions(buildResult.missing, body),
        warnings,
        ...(quotaWarning ? { quotaWarning } : {})
      });
    }
    const inferred = normalizeInferred(parsed.inferred);
    const timelineOp = normalizeTimelineOp(parsed.op);

    if (mode === "moment") {
      if (buildResult.plan.scenarios.length > 1) {
        buildResult.plan.scenarios = [buildResult.plan.scenarios[0]];
        buildResult.plan.labelWeights = {
          [buildResult.plan.scenarios[0].id]: 1
        };
      }
      return NextResponse.json<AgentResponse>({
        mode: "moment",
        plan: buildResult.plan,
        planPatch: buildResult.planPatch,
        ...(timelineOp ? { op: timelineOp } : {}),
        ...(hasVideoSource(body) ? { autoRun: true } : {}),
        momentDescription:
          typeof parsed.momentDescription === "string"
            ? parsed.momentDescription.slice(0, 400)
            : userText,
        message: stringOr(parsed.message, "Locating the moment in your video."),
        userTier,
        inferred,
        warnings,
        ...(quotaWarning ? { quotaWarning } : {})
      });
    }

    return NextResponse.json<AgentResponse>({
      mode: "plan",
      plan: buildResult.plan,
      planPatch: buildResult.planPatch,
      ...(timelineOp ? { op: timelineOp } : {}),
      ...(hasVideoSource(body) ? { autoRun: true } : {}),
      message: stringOr(parsed.message, "Plan ready."),
      userTier,
      inferred,
      warnings,
      ...(quotaWarning ? { quotaWarning } : {})
    });
  }

  // v1.5.2 — Unreachable in normal flow because resolveMode() always
  // returns a valid IntentMode, but TypeScript can't prove that and we
  // never want to crash on a future mode either. Surface a friendly
  // clarify question instead of a dev-string error. The user keeps
  // their existing plan and just gets asked what they wanted.
  return NextResponse.json<AgentResponse>({
    mode: "clarify",
    message: "I didn't quite catch that — what would you like me to do?",
    questions: [
      defaultClarifyQuestion(body.currentPlan ?? null, clarifyContext(body))
    ],
    warnings,
    ...(quotaWarning ? { quotaWarning } : {})
  });
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function rateLimitResponse(rl: RateLimitDecision): NextResponse<AgentResponse> {
  const status = rl.status ?? 429;
  let userMessage: string;
  if (rl.reason === "global_budget") {
    userMessage =
      "We're at our shared daily AI capacity. Please try again after midnight UTC.";
  } else if (rl.reason?.startsWith("circuit_open")) {
    userMessage = "The AI model is temporarily unavailable. Try again shortly.";
  } else if (rl.reason === "session_strict_burst") {
    userMessage =
      "You've been auto-throttled after repeated rate-limit hits. Slow down for a few minutes.";
  } else {
    userMessage = "Too many requests. Please slow down.";
  }
  return NextResponse.json<AgentResponse>(
    {
      mode: "error",
      error: userMessage,
      transient: true,
      retryAfterSeconds: rl.retryAfterSeconds
    },
    {
      status,
      headers: rl.retryAfterSeconds
        ? { "Retry-After": String(rl.retryAfterSeconds) }
        : undefined
    }
  );
}

function buildQuotaWarning(
  rl: RateLimitDecision
): { usage: number; limit: number; fraction: number } | null {
  if (rl.tier === "soft" && typeof rl.usage === "number" && typeof rl.limit === "number") {
    return {
      usage: rl.usage,
      limit: rl.limit,
      fraction: rl.limit > 0 ? rl.usage / rl.limit : 0
    };
  }
  return null;
}

function validateRequest(body: AgentRequest): string | null {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return "messages must be a non-empty array";
  }
  const last = body.messages[body.messages.length - 1];
  if (!last || last.role !== "user" || typeof last.content !== "string" || !last.content.trim()) {
    return "the latest message must be a non-empty user message";
  }
  if (last.content.length > CONVERSATION.maxUserRequestChars) {
    return "userRequest too long";
  }
  if (typeof body.recentActivity === "string" && body.recentActivity.length > 4000) {
    return "recentActivity too long";
  }
  return null;
}

interface ResolveOk {
  ok: true;
  plan: EditPlan;
  planPatch?: PlanPatch;
}
interface ResolveErr {
  ok: false;
  missing: string[];
}

/**
 * v1.5.2 — Defensively figure out the mode the planner intended.
 *
 * The system prompt instructs the LLM to always emit a "mode" field
 * with one of five values (plan / moment / extract / acknowledge /
 * clarify). In practice, frontier models occasionally drop the field
 * or invent a synonym, especially on context-update turns ("there's
 * a defeat title in this video") where the LLM just produces a bare
 * { message: "..." } and forgets the envelope.
 *
 * Before v1.5.2 that crashed the route with
 *   Planner returned an unknown mode "undefined".
 * which was leaking dev-strings straight into the chat UI.
 *
 * This helper rescues the turn by inspecting the JSON the LLM DID
 * send. It only looks at the model's own structured output — it does
 * NOT read the user's text — so the project-wide "no regex/keyword
 * heuristics on user input" rule is preserved.
 *
 * Resolution order (most specific first):
 *   1. mode is one of the five known values → use it.
 *   2. extractRange present → "extract".
 *   3. non-empty questions array → "clarify".
 *   4. momentDescription string → "moment".
 *   5. plan or planPatch present → "plan".
 *   6. message-only payload → "acknowledge" (treat as a simple
 *      conversational reply that should leave state alone).
 *   7. Truly empty payload → "clarify" (ask the user to repeat).
 */
function resolveMode(parsed: Record<string, unknown>): IntentMode {
  const raw = parsed.mode;
  if (
    raw === "plan" ||
    raw === "moment" ||
    raw === "extract" ||
    raw === "edit" ||
    raw === "describe" ||
    raw === "briefing" ||
    raw === "promote" ||
    raw === "merge" ||
    raw === "compose" ||
    raw === "acknowledge" ||
    raw === "clarify"
  ) {
    return raw;
  }
  // v1.8.0 — compose envelopes carry a `compose.sources` array. Detect by
  // shape when the mode field is missing/mistyped.
  if (
    parsed.compose &&
    typeof parsed.compose === "object" &&
    Array.isArray((parsed.compose as Record<string, unknown>).sources)
  ) {
    return "compose";
  }
  if (Array.isArray(parsed.operations) && parsed.operations.length > 0) {
    return "edit";
  }
  if (
    parsed.target &&
    typeof parsed.target === "object" &&
    typeof parsed.question === "string" &&
    (parsed.question as string).trim()
  ) {
    return "describe";
  }
  // v1.7.0 — briefing turns carry a samplePlan envelope without a
  // target.kind. Detect by shape if mode is missing.
  if (
    parsed.samplePlan &&
    typeof parsed.samplePlan === "object" &&
    typeof parsed.question === "string" &&
    (parsed.question as string).trim()
  ) {
    return "briefing";
  }
  // v1.7.2 — promote envelopes carry partIds/targetSeconds/op without
  // a sample plan. The presence of `partIds` (or `targetSeconds` with
  // an "op") is a strong shape signal even when mode is missing.
  if (
    Array.isArray(parsed.partIds) ||
    (typeof parsed.targetSeconds === "number" &&
      (parsed.op === "append" || parsed.op === "replace"))
  ) {
    return "promote";
  }
  if (parsed.extractRange && typeof parsed.extractRange === "object") {
    return "extract";
  }
  if (Array.isArray(parsed.questions) && parsed.questions.length > 0) {
    return "clarify";
  }
  if (
    typeof parsed.momentDescription === "string" &&
    parsed.momentDescription.trim()
  ) {
    return "moment";
  }
  if (parsed.plan || parsed.planPatch) {
    return "plan";
  }
  if (typeof parsed.message === "string" && parsed.message.trim()) {
    return "acknowledge";
  }
  return "clarify";
}

/**
 * v1.7.0 — Validate the samplePlan envelope from the planner's
 * briefing-mode JSON. Falls back to sensible defaults so the client
 * always gets a workable plan even if the LLM was sloppy.
 *
 *   count: clamped to [4, 16]; default 12.
 *   range: optional; rejected if startSeconds >= endSeconds or either
 *          is non-finite. The client interprets a missing range as
 *          "whole active video".
 */
function normalizeBriefingSamplePlan(
  raw: unknown
): { count: number; range?: { startSeconds: number; endSeconds: number } } {
  const o =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  let count = 12;
  if (typeof o.count === "number" && Number.isFinite(o.count)) {
    count = Math.round(o.count);
  } else if (typeof o.count === "string") {
    const parsed = Number(o.count);
    if (Number.isFinite(parsed)) count = Math.round(parsed);
  }
  count = Math.min(16, Math.max(4, count));

  let range: { startSeconds: number; endSeconds: number } | undefined;
  if (o.range && typeof o.range === "object") {
    const r = o.range as Record<string, unknown>;
    const num = (v: unknown): number | null => {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string") {
        const p = Number(v);
        if (Number.isFinite(p)) return p;
      }
      return null;
    };
    const s = num(r.startSeconds);
    const e = num(r.endSeconds);
    if (s != null && e != null && s >= 0 && e > s + 0.5) {
      range = { startSeconds: s, endSeconds: e };
    }
  }
  return range ? { count, range } : { count };
}

function resolvePlan(args: {
  mode: "plan" | "moment";
  parsed: Record<string, unknown>;
  currentPlan: EditPlan | null;
  warnings: string[];
}): ResolveOk | ResolveErr {
  const { parsed, currentPlan, warnings } = args;

  if (parsed.planPatch && currentPlan) {
    const { patch, warnings: pw } = normalizePlanPatch(parsed.planPatch);
    warnings.push(...pw);
    const merged = mergePlan(currentPlan, patch);
    return { ok: true, plan: merged, planPatch: patch };
  }

  if (parsed.plan) {
    const { plan, missing, warnings: pw } = normalizePlan(parsed.plan);
    warnings.push(...pw);
    if (plan) {
      return { ok: true, plan };
    }
    if (currentPlan) {
      const { patch } = normalizePlanPatch(parsed.plan);
      const merged = mergePlan(currentPlan, patch);
      return { ok: true, plan: merged, planPatch: patch };
    }
    return { ok: false, missing };
  }

  if (parsed.planPatch && !currentPlan) {
    const { patch, warnings: pw } = normalizePlanPatch(parsed.planPatch);
    warnings.push(...pw);
    if (!patch.scenarios || patch.scenarios.length === 0) {
      return { ok: false, missing: ["scenarios"] };
    }
    const { plan, missing } = normalizePlan({
      ...patch,
      labelWeights: patch.labelWeights ?? {}
    });
    if (plan) return { ok: true, plan };
    return { ok: false, missing };
  }

  return { ok: false, missing: ["plan"] };
}

function normalizeUserTier(raw: unknown): UserTier {
  return raw === "advanced" ? "advanced" : "novice";
}

/** v1.7.9 — Normalize the optional top-level `op` field the planner
 *  emits on plan / moment / extract turns. Returns undefined when the
 *  planner didn't express a preference, in which case the CLIENT
 *  decides (append when the timeline already has clips, replace when
 *  it's empty). We only ever honour an explicit "append" / "replace"
 *  — never guess from anything else. */
function normalizeTimelineOp(raw: unknown): "append" | "replace" | undefined {
  return raw === "append" || raw === "replace" ? raw : undefined;
}

/** v1.5.0 — validate an extractRange returned at the top level of the
 *  agent response (mode="extract" path). Mirrors the validation in
 *  lib/plan/normalize.ts but lives here because it's used outside the
 *  plan-resolution flow. */
function normalizeExtractRangeForResponse(raw: unknown): ExtractRange | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind =
    r.kind === "first" || r.kind === "last" || r.kind === "absolute"
      ? r.kind
      : "absolute";
  const start =
    typeof r.startSeconds === "number" && isFinite(r.startSeconds)
      ? Math.max(0, r.startSeconds)
      : 0;
  const end =
    typeof r.endSeconds === "number" && isFinite(r.endSeconds)
      ? Math.max(0, r.endSeconds)
      : 0;
  if (kind !== "last" && end <= start) return null;
  if (kind === "last" && end <= 0) return null;
  const spoken =
    typeof r.spoken === "string" && r.spoken.trim()
      ? r.spoken.trim().slice(0, 120)
      : undefined;
  return { kind, startSeconds: start, endSeconds: end, spoken };
}

/**
 * v1.6.1 — Validate + sanitize the LLM-emitted EditOperation list.
 *
 * Per-op rules:
 *   - kind must be one of the seven known kinds; unknown ops are dropped.
 *   - Numeric fields are coerced to finite non-negative numbers; non-finite
 *     or negative values reject the whole op.
 *   - For range ops, endSeconds must be > startSeconds (≥ 100ms apart).
 *   - sourceId is passed through if it's a non-empty string; otherwise
 *     undefined so the client falls back to the active source.
 *   - Hard cap at 16 operations per turn (defensive against runaway LLM
 *     output — the user can do another turn for more edits).
 *
 * Returns a clean array; the caller decides what to do when it's empty.
 */
function normalizeEditOperations(raw: unknown): EditOperation[] {
  if (!Array.isArray(raw)) return [];
  const out: EditOperation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = typeof o.kind === "string" ? o.kind.trim() : "";
    const sourceId =
      typeof o.sourceId === "string" && o.sourceId.trim()
        ? o.sourceId.trim().slice(0, 64)
        : undefined;
    const op = buildOp(kind, o, sourceId);
    if (op) out.push(op);
    if (out.length >= 16) break;
  }
  return out;
}

function buildOp(
  kind: string,
  o: Record<string, unknown>,
  sourceId: string | undefined
): EditOperation | null {
  // Local helpers for parsing numbers — accept either pure numbers or
  // numeric strings so the LLM has a tiny bit of slack.
  const num = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim()) {
      const parsed = Number(v.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  };

  switch (kind) {
    case "trim_first":
    case "trim_last": {
      const s = num(o.seconds);
      if (s == null || s <= 0) return null;
      return { kind, seconds: s, sourceId };
    }
    case "keep_range":
    case "drop_range": {
      const a = num(o.startSeconds);
      const b = num(o.endSeconds);
      if (a == null || b == null) return null;
      if (a < 0 || b <= a + 0.1) return null;
      return { kind, startSeconds: a, endSeconds: b, sourceId };
    }
    case "split_at": {
      const t = num(o.timeSeconds);
      if (t == null || t < 0) return null;
      return { kind, timeSeconds: t, sourceId };
    }
    case "split_selected":
    case "reset_source":
    case "undo":
      return { kind, sourceId };
    default:
      return null;
  }
}

/**
 * v1.6.4 — Normalize a `describe` mode target. Accepts either:
 *   { kind: "clip", clipId: "..." }
 *   { kind: "range", sourceId?, startSeconds, endSeconds }
 *
 * Returns null when the shape is unrecognisable so the caller can fall
 * back to a clarify question. Numbers are coerced from strings the LLM
 * may have produced ("12.5" instead of 12.5); negative ranges and
 * empty clipIds are rejected.
 */
function normalizeDescribeTarget(
  raw: unknown
):
  | { kind: "clip"; clipId: string }
  | { kind: "range"; sourceId?: string; startSeconds: number; endSeconds: number }
  | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim()) {
      const p = Number(v.trim());
      if (Number.isFinite(p)) return p;
    }
    return null;
  };

  if (o.kind === "clip") {
    const id =
      typeof o.clipId === "string" && o.clipId.trim()
        ? o.clipId.trim().slice(0, 64)
        : null;
    if (!id) return null;
    return { kind: "clip", clipId: id };
  }

  if (o.kind === "range") {
    const s = num(o.startSeconds);
    const e = num(o.endSeconds);
    if (s == null || e == null) return null;
    if (s < 0 || e <= s + 0.1) return null;
    const sid =
      typeof o.sourceId === "string" && o.sourceId.trim()
        ? o.sourceId.trim().slice(0, 64)
        : undefined;
    return { kind: "range", sourceId: sid, startSeconds: s, endSeconds: e };
  }

  // Older / sloppier LLM output — accept "clipId" or "startSeconds" at
  // the top level without an explicit kind, infer from shape.
  if (typeof o.clipId === "string" && o.clipId.trim()) {
    return { kind: "clip", clipId: o.clipId.trim().slice(0, 64) };
  }
  const s = num(o.startSeconds);
  const e = num(o.endSeconds);
  if (s != null && e != null && s >= 0 && e > s + 0.1) {
    const sid =
      typeof o.sourceId === "string" && o.sourceId.trim()
        ? o.sourceId.trim().slice(0, 64)
        : undefined;
    return { kind: "range", sourceId: sid, startSeconds: s, endSeconds: e };
  }
  return null;
}

function normalizeInferred(raw: unknown): InferredField[] {
  if (!Array.isArray(raw)) return [];
  const out: InferredField[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.field !== "string" || !o.field.trim()) continue;
    if (typeof o.reason !== "string" || !o.reason.trim()) continue;
    let value: InferredField["value"];
    if (
      typeof o.value === "string" ||
      typeof o.value === "number" ||
      typeof o.value === "boolean"
    ) {
      value = o.value;
    } else if (Array.isArray(o.value) && o.value.every((x) => typeof x === "string")) {
      value = o.value as string[];
    } else {
      value = JSON.stringify(o.value).slice(0, 80);
    }
    out.push({
      field: o.field.trim().slice(0, 40),
      value,
      reason: o.reason.trim().slice(0, 160)
    });
    if (out.length >= 6) break;
  }
  return out;
}

function normalizeClarifyQuestions(raw: unknown): ClarifyQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: ClarifyQuestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id =
      typeof o.id === "string" && o.id.trim() ? o.id.trim().slice(0, 32) : `q_${out.length}`;
    const prompt = typeof o.prompt === "string" ? o.prompt.trim() : "";
    if (!prompt) continue;
    const suggestionsRaw = Array.isArray(o.suggestions) ? o.suggestions : [];
    const suggestions = suggestionsRaw
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 5);
    if (suggestions.length === 0) continue;
    const kind = o.kind === "free-text" ? "free-text" : "single-choice";
    out.push({ id, prompt: prompt.slice(0, 200), suggestions, kind });
    if (out.length >= 3) break;
  }
  return out;
}

function defaultClarifyQuestion(
  currentPlan: EditPlan | null,
  context?: {
    /** Active source duration in seconds, if known. Adapts the chip
     *  suggestions: long videos (>5 min) lean broad/exploratory; short
     *  videos can lean narrow. v1.6.3. */
    durationSeconds?: number;
    /** Per-source notes the user volunteered ("this is a podcast",
     *  "wedding ceremony"). Used as light hints — never as keyword
     *  switches. v1.6.3. */
    notes?: string[];
  }
): ClarifyQuestion {
  if (!currentPlan) {
    // Universal chips that read naturally for any genre. The narrow
    // ones (Funniest / Most action) sit alongside broad alternatives
    // (Highlights / Key moments) so the user isn't forced to pick a
    // sports/comedy framing for a lecture or a meditation tape.
    //
    // Order matters — the chip the user picks becomes the topic the
    // LLM acts on. We also include "Just describe it…" so users with
    // a specific idea aren't railroaded into a quick-reply.
    const dur = context?.durationSeconds ?? 0;
    const isLong = dur >= 300; // 5 minutes
    const broad = ["Highlights", "Key moments", "Best parts"];
    const narrow = ["Funniest moments", "Most action", "Most emotional"];
    const picks = isLong
      ? [...broad, "Find a specific scene"]
      : [...narrow, "Highlights", "Find a specific scene"];
    return {
      id: "topic",
      prompt: "What kind of moments should I look for?",
      suggestions: picks.slice(0, 5),
      kind: "single-choice"
    };
  }
  // v1.7.1 — When a refinement-mode plan exists but the planner didn't
  // give us enough to act, we used to fall back to a "duration"
  // question with hardcoded chips. That ask is gone — total timing is
  // now emergent (see Duration & append rules in the planner prompt).
  // Use the same "next step" question as the no-plan path so the user
  // is never trapped in a templated duration picker.
  return {
    id: "next_step",
    prompt: "What would you like next \u2014 describe what's there, add more clips, or trim?",
    suggestions: [
      "Describe the whole video",
      "Add more clips",
      "Trim to fit",
      "Find a specific moment"
    ],
    kind: "single-choice"
  };
}

function missingFieldsToQuestions(
  missing: string[],
  body?: AgentRequest
): ClarifyQuestion[] {
  // Right now both branches return the same default; left as a function so
  // future field-specific clarifications can plug in here.
  void missing;
  return [
    defaultClarifyQuestion(null, body ? clarifyContext(body) : undefined)
  ];
}

/**
 * v1.6.3 — Derive a small context bundle from the agent request so
 * defaultClarifyQuestion can pick chip suggestions that fit the
 * footage genre. We use only the active source's duration + any notes
 * the user volunteered. This is NOT a regex on user text — it's a
 * shape read on metadata + structured chips.
 */
function clarifyContext(body: AgentRequest): {
  durationSeconds?: number;
  notes?: string[];
} {
  const lib = body.videoLibrary ?? [];
  const active =
    lib.find((s) => s.id === body.activeSourceId) ?? lib[0] ?? null;
  return {
    durationSeconds: active?.duration ?? body.videoMeta?.duration,
    notes: active?.notes
  };
}

/**
 * v1.9.x — True when the request carries at least one usable video source.
 * The client sends `videoMeta` only when a video is loaded and
 * `videoLibrary` only when sources exist, so either signals a source.
 */
function hasVideoSource(body: AgentRequest): boolean {
  return Boolean(body.videoMeta) || (body.videoLibrary?.length ?? 0) > 0;
}

// v1.8.1 — build a compose-mode AgentResponse from a deterministic compose
// intent. Shared by the priority override + every fallback site so the turn
// never degrades to a single-source / junk plan for a multi-source request.
function buildComposeResponse(
  result: ComposeIntentResult,
  body: AgentRequest,
  warnings: string[],
  quotaWarning: ReturnType<typeof buildQuotaWarning>
): NextResponse<AgentResponse> {
  return NextResponse.json<AgentResponse>({
    mode: "compose",
    compose: result.plan,
    ...(hasVideoSource(body) ? { autoRun: true } : {}),
    message: result.message,
    inferred: [],
    warnings,
    ...(quotaWarning ? { quotaWarning } : {})
  });
}

/**
 * v1.9.x — Context-aware clarify message that REPLACES the old static
 * "what should the short be about?" dead-end. It adapts to whether a video
 * exists: with no source we ask only for an upload; with a source we invite
 * a focus OR an explicit "best parts" without forcing a topic framing.
 */
function dynamicClarifyMessage(body: AgentRequest): string {
  if (!hasVideoSource(body)) {
    return "Upload a video first \u2014 then tell me what to feature (e.g. \u201Cingredient shots\u201D, \u201Cfunny bits\u201D) and I\u2019ll build the short.";
  }
  return "Tell me what to feature \u2014 a focus like \u201Cingredient-only shots\u201D or \u201Cfunny moments\u201D, or just say \u201Cbest parts\u201D and I\u2019ll pick the highlights.";
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? cleanMessage(v.trim()) : fallback;
}

/**
 * Defensive cleanup of the planner's "message" field.
 *
 * The system prompt instructs the LLM to emit a single short conversational
 * sentence. Sometimes (especially older Gemini models) it ignores this and
 * dumps "Plan: ... Looking for: ... Avoiding: ... Why: ...". We strip those
 * verbose prefixes server-side so the chat never shows the dump even on a
 * misbehaving turn. Worst case we lose some detail that's already shown in
 * the PlanPreview card — net win for the user.
 */
function cleanMessage(raw: string): string {
  if (!raw) return "";
  let s = raw;
  // Drop "Plan: ..." line at the start (with or without trailing newline)
  s = s.replace(/^\s*Plan:[^\n]*\n?/i, "");
  // Drop section-prefixed lines anywhere
  s = s.replace(/^\s*(?:Looking for|Avoiding|Why|Rationale|Scenarios?):[^\n]*\n?/gim, "");
  s = s.trim();
  if (!s) return "";
  // Take the first sentence (or first 160 chars).
  const firstSentenceMatch = s.match(/^.+?[.!?](?=\s|$)/);
  let first = firstSentenceMatch ? firstSentenceMatch[0] : s;
  if (first.length > 160) first = first.slice(0, 159) + "\u2026";
  return first;
}

// Suppress unused-symbol warnings for re-exported types.
export type _UnusedRateLimits = typeof RATE_LIMITS;



// ---------------------------------------------------------------------
// v1.6.2 — Anti-loop helpers
// ---------------------------------------------------------------------

/**
 * Walk back through the message history and return the most recent
 * assistant turn (or null if there isn't one). Used to detect the
 * "two clarifies in a row" loop pattern.
 */
function findPreviousAssistant(messages: ChatMessage[]): ChatMessage | null {
  for (let i = messages.length - 2; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i];
  }
  return null;
}

/**
 * Heuristic on OUR OWN OUTPUT — never on user text. Returns true when a
 * past assistant turn was a clarify. We check two signals and keep them
 * narrow on purpose so a real plan turn that happens to mention the
 * word "what" doesn't trip the safety net:
 *
 *   1. The turn carried a structured `clarify` attachment (the chat
 *      pipeline tags clarify messages this way).
 *   2. The visible message text begins with "I need a bit more" or
 *      ends with a question mark AND is short (≤ 140 chars).
 *
 * These are heuristics on assistant output, not user input — so the
 * project rule "no regex on user text" is preserved.
 */
function looksLikeClarify(prev: ChatMessage | null): boolean {
  if (!prev) return false;
  const att = prev.attachment as { mode?: string } | undefined;
  if (att && att.mode === "clarify") return true;
  const text = (prev.content || "").trim();
  if (!text) return false;
  if (text.length > 200) return false;
  if (text.toLowerCase().startsWith("i need a bit more")) return true;
  if (text.toLowerCase().includes("what kind of moments")) return true;
  if (text.toLowerCase().includes("what should the short be about")) return true;
  if (text.endsWith("?")) return true;
  return false;
}

/**
 * Build a vague plan to break out of a clarify loop. We use the user's
 * literal text as the SCENARIO PROMPT (not as keywords for branching).
 * If the text is long enough (≥ 3 chars), SigLIP scores against it
 * directly. If it's too short to be useful, we fall back to a
 * motion+saliency plan that picks visually busy moments without the
 * semantic pass.
 *
 * This is identical in spirit to what the LLM SHOULD have done; we're
 * just doing it deterministically when the model fails to.
 */
function synthesizeVaguePlan(args: {
  userText: string;
  currentPlan: EditPlan | null;
  memory?: SessionMemory;
  /** v1.7.12 — when a briefing is in scope, its best-part labels are used
   *  as extra grounding so the synthesized scenario is concrete (tied to
   *  what the video actually contains) rather than just the raw chip text.
   *  Optional; absent keeps the original literal-text behaviour. */
  lastBriefing?: {
    sourceId: string;
    sourceName?: string;
    bestParts: Array<{
      id: string;
      startSeconds: number;
      endSeconds: number;
      label: string;
      why: string;
    }>;
  };
  /** v1.9.x — derived actionable intent (duration / focus / exclusivity /
   *  format) from imperfect user text. When present it grounds the scenario
   *  on the focus phrase and applies the stated duration, format and
   *  exclusion constraints — so a request like "ingredient part alone for
   *  1min" yields a 60s, ingredient-only plan instead of a topic clarify. */
  intent?: ActionableIntent;
}): EditPlan {
  // Prefer the derived focus phrase (e.g. "ingredient") as the scenario the
  // pipeline scores against; fall back to the user's literal text.
  const baseText =
    args.intent?.rawFocus && args.intent.rawFocus.length >= 2
      ? args.intent.rawFocus
      : args.userText;
  const text = baseText.trim().slice(0, 200);
  const useSemantic = text.length >= 3;

  const scenarios: Array<{ id: string; prompt: string; weight: number }> = [];
  const labelWeights: Record<string, number> = {};
  const slug = (s: string, fallback: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) ||
    fallback;

  // v1.9.x — when an actionable intent provides CLEAN scenario labels
  // ("ingredient-only moments", "cooking moments"), use those verbatim as the
  // scenario prompts. This is what stops the UI's "Looking for" row from
  // echoing the user's raw, broken text (e.g. "see what he cooking and catch
  // ingrdient"). One scenario per label, evenly weighted.
  if (args.intent && args.intent.scenarioLabels.length > 0) {
    const labels = args.intent.scenarioLabels.slice(0, 4);
    const w = +(1 / labels.length).toFixed(3);
    labels.forEach((label, i) => {
      const id = slug(label, `topic_${i}`);
      scenarios.push({ id, prompt: label, weight: 1 });
      labelWeights[id] = w;
    });
  } else if (useSemantic) {
    // v1.7.13 (Bug 2 fix) — build ONE primary scenario grounded by, but not
    // broadened by, the briefing. Previously every best-part label was added
    // as a separate ~equal scenario, which diluted a specific request like
    // "ingredient preparation clips" with unrelated parts. Instead we keep a
    // single scenario whose prompt is the user's text plus a COMPACT context
    // phrase distilled from the briefing labels. SigLIP still scores primarily
    // against the user's intent; the context only nudges it toward this
    // video's domain. Generic (derived from briefing data, no keyword table).
    const id = slug(text, "topic");
    let prompt = text;
    const labels = (args.lastBriefing?.bestParts ?? [])
      .map((p) => (p.label ?? "").trim())
      .filter((l) => l.length >= 3)
      // Drop labels already implied by the user's text to avoid redundancy.
      .filter((l) => !text.toLowerCase().includes(l.toLowerCase()))
      .slice(0, SYNTH_PLAN.maxContextLabels);
    if (labels.length > 0) {
      const context = labels.join(", ").slice(0, SYNTH_PLAN.maxContextChars);
      prompt = `${text}. Relevant video context: ${context}`.slice(0, 300);
    }
    scenarios.push({ id, prompt, weight: 1 });
    labelWeights[id] = 1;
  }

  // Bug 2: semantic-heavy signals for a concrete topic (a named subject
  // should lean on SigLIP, not motion/saliency). The visual-interest
  // fallback (no usable text) stays motion+saliency only.
  //
  // Issue #62 — a GENERIC best-parts ask ("best picks", "make a 40s reel")
  // has no concrete subject. Scoring SigLIP against a placeholder label like
  // "visually rich moments" is meaningless and was producing weak 0.3x
  // matches. Force pure visual-interest scoring (semantic = 0 → SigLIP is
  // skipped entirely; motion + saliency drive selection). This is the
  // CPU/offline-friendly path: no WebGPU, no cloud required.
  const genericBestParts = args.intent?.genericBestParts === true;
  const signals = genericBestParts
    ? { ...SIGNAL_DEFAULTS.visualInterest }
    : useSemantic
      ? { semantic: 0.65, motion: 0.2, saliency: 0.15 }
      : { semantic: 0, motion: 0.6, saliency: 0.4 };
  const target =
    args.intent?.targetSeconds ??
    args.memory?.duration ??
    args.currentPlan?.targetShortSeconds ??
    PLAN_DEFAULTS.targetShortSeconds;
  // v1.7.1 — synthesizeVaguePlan fires when the user gave us nothing
  // to go on. Keeping userSpecifiedDuration false means the pipeline
  // will pick clips by quality floor instead of trimming to a 30s
  // budget the user never asked for.
  // v1.9.x — a duration parsed from the user's text (intent) IS an explicit
  // request, so it flips userSpecifiedDuration true and is enforced.
  const userSpecifiedDuration =
    args.intent?.userSpecifiedDuration === true ||
    args.memory?.duration !== undefined ||
    args.currentPlan?.userSpecifiedDuration === true;
  // Merge any derived exclusions with remembered skips (deduped).
  const avoid = Array.from(
    new Set([
      ...(args.memory?.skip ?? []),
      ...(args.intent?.negativeConstraints ?? [])
    ])
  ).slice(0, 8);
  return {
    scenarios,
    labelWeights,
    targetShortSeconds: target,
    userSpecifiedDuration,
    maxClipSeconds: PLAN_DEFAULTS.maxClipSeconds,
    minClipSeconds: PLAN_DEFAULTS.minClipSeconds,
    selectionStrategy: PLAN_DEFAULTS.selectionStrategy,
    format: args.intent?.format ?? args.memory?.format ?? PLAN_DEFAULTS.format,
    transition: PLAN_DEFAULTS.transition,
    styles: args.memory?.styles ?? [],
    avoid,
    sampleEverySeconds: PLAN_DEFAULTS.sampleEverySeconds,
    inferenceWidth: PLAN_DEFAULTS.inferenceWidth,
    signals
  };
}

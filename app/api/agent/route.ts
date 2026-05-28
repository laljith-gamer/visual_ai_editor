import { NextRequest, NextResponse } from "next/server";
import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import { sessionOptions, type SessionData } from "@/lib/session/cookie";
import {
  checkAllLimits,
  recordFailure,
  recordSuccess
} from "@/lib/ratelimit";
import { hasAnyChatProvider, hasGemini, serverEnv } from "@/lib/env";
import { geminiJson, isTransientError } from "@/lib/providers/gemini";
import { groqJson } from "@/lib/providers/groq";
import {
  PLANNER_SYSTEM_PROMPT,
  buildPlannerUserPrompt
} from "@/lib/plan/prompt";
import { normalizePlan, normalizePlanPatch } from "@/lib/plan/normalize";
import { mergePlan } from "@/lib/plan/merge";
import { extractJsonObject } from "@/lib/util/safeJson";
import { newId } from "@/lib/util/id";
import { CONVERSATION, RATE_LIMITS } from "@/lib/config";
import type {
  AgentRequest,
  AgentResponse,
  ClarifyQuestion,
  EditPlan,
  ExtractRange,
  InferredField,
  IntentMode,
  PlanPatch,
  RateLimitDecision,
  UserTier
} from "@/lib/types";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasAnyChatProvider()) {
    return NextResponse.json<AgentResponse>(
      {
        mode: "error",
        error: "No chat provider configured. Set GEMINI_API_KEY or GROQ_API_KEY."
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

  // ---- Layers 2/3/4 rate check (Layer 1 already ran in middleware) ---
  const rl = await checkAllLimits({
    sid: session.sid,
    scope: "agent",
    consumesLlm: true,
    provider: "gemini"
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

  // ---- Build the planner prompt -------------------------------------
  // No regex / keyword heuristics on the server. The LLM does ALL intent
  // understanding from the user's words + the structured context below.
  const userPrompt = buildPlannerUserPrompt({
    messages,
    currentPlan: body.currentPlan ?? null,
    videoMeta: body.videoMeta,
    videoLibrary: body.videoLibrary,
    memory: body.memory,
    recentActivity:
      typeof body.recentActivity === "string" ? body.recentActivity : undefined
  });

  // ---- Call LLM with circuit-aware fallback chain --------------------
  const warnings: string[] = [];
  let raw: string;
  try {
    if (hasGemini()) {
      try {
        raw = await geminiJson(PLANNER_SYSTEM_PROMPT, userPrompt);
        await recordSuccess("gemini");
      } catch (err) {
        await recordFailure("gemini");
        // Try Groq if available before surfacing failure.
        if (serverEnv.GROQ_API_KEY) {
          raw = await groqJson(PLANNER_SYSTEM_PROMPT, userPrompt);
          warnings.push("Gemini failed; used Groq fallback.");
        } else {
          throw err;
        }
      }
    } else {
      raw = await groqJson(PLANNER_SYSTEM_PROMPT, userPrompt);
    }
  } catch (e2) {
    const transient = isTransientError(e2);
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
      message: stringOr(parsed.message, "Grabbing that exact slice."),
      inferred,
      warnings,
      ...(quotaWarning ? { quotaWarning } : {})
    });
  }

  // ---- CLARIFY -------------------------------------------------------
  if (mode === "clarify") {
    const questions = normalizeClarifyQuestions(parsed.questions);
    if (questions.length === 0) {
      questions.push(defaultClarifyQuestion(body.currentPlan ?? null));
    }
    return NextResponse.json<AgentResponse>({
      mode: "clarify",
      message:
        typeof parsed.message === "string" && parsed.message.trim()
          ? cleanMessage(parsed.message.trim()) || "I need a bit more to plan the cuts."
          : "I need a bit more to plan the cuts.",
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
      return NextResponse.json<AgentResponse>({
        mode: "clarify",
        message:
          "I need a bit more before I can run the analysis — what should the short be about?",
        questions: missingFieldsToQuestions(buildResult.missing),
        warnings,
        ...(quotaWarning ? { quotaWarning } : {})
      });
    }
    const inferred = normalizeInferred(parsed.inferred);

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
    questions: [defaultClarifyQuestion(body.currentPlan ?? null)],
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
    raw === "acknowledge" ||
    raw === "clarify"
  ) {
    return raw;
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

function defaultClarifyQuestion(currentPlan: EditPlan | null): ClarifyQuestion {
  if (!currentPlan) {
    return {
      id: "topic",
      prompt: "What kind of moments should I look for?",
      suggestions: [
        "Funniest moments",
        "Most action",
        "Most emotional",
        "Find a specific scene instead"
      ],
      kind: "single-choice"
    };
  }
  return {
    id: "duration",
    prompt: "How long should the short be?",
    suggestions: ["15 seconds", "30 seconds", "60 seconds", "90 seconds"],
    kind: "single-choice"
  };
}

function missingFieldsToQuestions(missing: string[]): ClarifyQuestion[] {
  // Right now both branches return the same default; left as a function so
  // future field-specific clarifications can plug in here.
  void missing;
  return [defaultClarifyQuestion(null)];
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

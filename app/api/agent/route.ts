import { NextRequest, NextResponse } from "next/server";
import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import { sessionOptions, type SessionData } from "@/lib/session/cookie";
import { checkRateLimit } from "@/lib/ratelimit";
import { hasAnyChatProvider, hasGemini, serverEnv } from "@/lib/env";
import { geminiJson, isTransientError } from "@/lib/providers/gemini";
import { groqJson } from "@/lib/providers/groq";
import {
  PLANNER_SYSTEM_PROMPT,
  buildPlannerUserPrompt
} from "@/lib/plan/prompt";
import { normalizePlan, normalizePlanPatch } from "@/lib/plan/normalize";
import { mergePlan } from "@/lib/plan/merge";
import { inferIntent } from "@/lib/plan/intent";
import { extractJsonObject } from "@/lib/util/safeJson";
import { newId } from "@/lib/util/id";
import { CONVERSATION } from "@/lib/config";
import type {
  AgentRequest,
  AgentResponse,
  ChatMessage,
  ClarifyQuestion,
  EditPlan,
  InferredField,
  PlanPatch
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

  const rl = await checkRateLimit(`agent:${session.sid}`);
  if (!rl.allowed) {
    return NextResponse.json<AgentResponse>(
      { mode: "error", error: "Rate limit exceeded. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.reset) } }
    );
  }

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

  // ---- Heuristic hint (advisory) ------------------------------------
  const hint = inferIntent({
    userMessage: userText,
    conversationHistory: messages.slice(0, -1),
    currentPlan: body.currentPlan ?? null,
    videoMeta: body.videoMeta,
    memory: body.memory ?? { styles: [], keep: [], skip: [] }
  });

  const userPrompt = buildPlannerUserPrompt({
    messages,
    currentPlan: body.currentPlan ?? null,
    videoMeta: body.videoMeta,
    memory: body.memory,
    hint
  });

  // ---- Call LLM ------------------------------------------------------
  const warnings: string[] = [];
  let raw: string;
  try {
    if (hasGemini()) {
      raw = await geminiJson(PLANNER_SYSTEM_PROMPT, userPrompt);
    } else {
      raw = await groqJson(PLANNER_SYSTEM_PROMPT, userPrompt);
    }
  } catch (err) {
    try {
      if (serverEnv.GROQ_API_KEY && hasGemini()) {
        raw = await groqJson(PLANNER_SYSTEM_PROMPT, userPrompt);
        warnings.push("Gemini failed; used Groq fallback.");
      } else {
        throw err;
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
  }

  // ---- Parse LLM JSON ------------------------------------------------
  const parsed = extractJsonObject<Record<string, unknown>>(raw);
  if (!parsed) {
    return NextResponse.json<AgentResponse>(
      { mode: "error", error: "Planner returned invalid JSON." },
      { status: 502 }
    );
  }

  const mode = parsed.mode;
  // ---- CLARIFY -------------------------------------------------------
  if (mode === "clarify") {
    const questions = normalizeClarifyQuestions(parsed.questions);
    if (questions.length === 0) {
      // The model said clarify but produced no questions; synthesize a sensible default.
      questions.push(defaultClarifyQuestion(body.currentPlan ?? null));
    }
    return NextResponse.json<AgentResponse>({
      mode: "clarify",
      message:
        typeof parsed.message === "string" && parsed.message.trim()
          ? parsed.message.trim()
          : "I need a bit more to plan the cuts.",
      questions,
      warnings
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
      // Couldn't form a usable plan AND no current one to fall back on.
      // Fall through to a clarify response targeted at the missing fields.
      return NextResponse.json<AgentResponse>({
        mode: "clarify",
        message:
          "I need a bit more before I can run the analysis — what should the short be about?",
        questions: missingFieldsToQuestions(buildResult.missing),
        warnings
      });
    }
    const inferred = normalizeInferred(parsed.inferred);

    if (mode === "moment") {
      // Enforce exactly one scenario in moment mode.
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
        inferred,
        warnings
      });
    }

    return NextResponse.json<AgentResponse>({
      mode: "plan",
      plan: buildResult.plan,
      planPatch: buildResult.planPatch,
      message: stringOr(parsed.message, "Plan ready."),
      inferred,
      warnings
    });
  }

  // ---- Unknown mode → treat as error --------------------------------
  return NextResponse.json<AgentResponse>(
    {
      mode: "error",
      error: `Planner returned an unknown mode "${String(mode)}".`
    },
    { status: 502 }
  );
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

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

function resolvePlan(args: {
  mode: "plan" | "moment";
  parsed: Record<string, unknown>;
  currentPlan: EditPlan | null;
  warnings: string[];
}): ResolveOk | ResolveErr {
  const { parsed, currentPlan, warnings } = args;

  // Refinement: planPatch + existing currentPlan → merge.
  if (parsed.planPatch && currentPlan) {
    const { patch, warnings: pw } = normalizePlanPatch(parsed.planPatch);
    warnings.push(...pw);
    const merged = mergePlan(currentPlan, patch);
    return { ok: true, plan: merged, planPatch: patch };
  }

  // Fresh plan: full plan object.
  if (parsed.plan) {
    const { plan, missing, warnings: pw } = normalizePlan(parsed.plan);
    warnings.push(...pw);
    if (plan) {
      return { ok: true, plan };
    }
    // Plan was provided but unusable — try merging into currentPlan as a patch.
    if (currentPlan) {
      const { patch } = normalizePlanPatch(parsed.plan);
      const merged = mergePlan(currentPlan, patch);
      return { ok: true, plan: merged, planPatch: patch };
    }
    return { ok: false, missing };
  }

  // Patch-only without current plan.
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
    const id = typeof o.id === "string" && o.id.trim() ? o.id.trim().slice(0, 32) : `q_${out.length}`;
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
  if (missing.includes("scenarios") || missing.includes("plan")) {
    return [defaultClarifyQuestion(null)];
  }
  return [defaultClarifyQuestion(null)];
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

// Suppress unused-variable warning for ChatMessage type import (used for type narrowing).
export type _UnusedChatMessage = ChatMessage;

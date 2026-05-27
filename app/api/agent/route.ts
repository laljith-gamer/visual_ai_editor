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
import { normalizePlan } from "@/lib/plan/normalize";
import { extractJsonObject } from "@/lib/util/safeJson";
import { newId } from "@/lib/util/id";

export const runtime = "nodejs";

interface AgentRequest {
  userRequest: string;
  videoDurationSeconds?: number;
  memory?: {
    duration?: number;
    format?: string;
    styles?: string[];
    keep?: string[];
    skip?: string[];
  };
}

export async function POST(req: NextRequest) {
  if (!hasAnyChatProvider()) {
    return NextResponse.json(
      { error: "No chat provider configured. Set GEMINI_API_KEY or GROQ_API_KEY." },
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
    return NextResponse.json(
      { error: "Rate limit exceeded. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.reset) } }
    );
  }

  let body: AgentRequest;
  try {
    body = (await req.json()) as AgentRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body?.userRequest || typeof body.userRequest !== "string") {
    return NextResponse.json({ error: "userRequest is required" }, { status: 400 });
  }
  if (body.userRequest.length > 4000) {
    return NextResponse.json({ error: "userRequest too long" }, { status: 400 });
  }

  const userPrompt = buildPlannerUserPrompt({
    userRequest: body.userRequest,
    memory: body.memory,
    videoDurationSeconds: body.videoDurationSeconds
  });

  const warnings: string[] = [];
  let raw: string;
  try {
    if (hasGemini()) {
      raw = await geminiJson(PLANNER_SYSTEM_PROMPT, userPrompt);
    } else {
      raw = await groqJson(PLANNER_SYSTEM_PROMPT, userPrompt);
    }
  } catch (err) {
    // Try the other provider if available.
    try {
      if (serverEnv.GROQ_API_KEY && hasGemini()) {
        raw = await groqJson(PLANNER_SYSTEM_PROMPT, userPrompt);
        warnings.push("Gemini failed; used Groq fallback");
      } else {
        throw err;
      }
    } catch (e2) {
      const transient = isTransientError(e2);
      const message = transient
        ? "The chat model is temporarily overloaded. Please try again in a few seconds."
        : `Planner failed: ${(e2 as Error).message}`;
      return NextResponse.json(
        { error: message, transient },
        { status: transient ? 503 : 502 }
      );
    }
  }

  const parsed = extractJsonObject(raw);
  if (!parsed) {
    return NextResponse.json(
      { error: "Planner returned invalid JSON", raw: raw.slice(0, 500) },
      { status: 502 }
    );
  }

  const plan = normalizePlan(parsed, warnings);
  return NextResponse.json({ plan, warnings });
}

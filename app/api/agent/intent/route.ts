// =====================================================================
// app/api/agent/intent/route.ts
//
// TEXT-ONLY Chat Brain endpoint. Two tasks:
//
//   { "task": "warmup" }   → cheaply warm the cloud text provider (so the
//                            first real resolve is fast) and report readiness.
//   { "task": "resolve", ... }  → classify an ambiguous chat turn / free-text
//                            answer into a strict ChatBrainIntent JSON.
//
// PRIVACY: this route accepts ONLY compact text state. It rejects any body
// containing media/secret-shaped keys (defense in depth) and never receives
// video bytes, frames, thumbnails, audio, or transcript bodies. Keys stay
// server-only via the existing provider dispatcher.
//
// When no cloud provider is configured (the default for this repo) warmup
// returns { status: "unavailable" } and resolve returns { intent: null } —
// the client then stays in deterministic mode with no error surfaced.
// =====================================================================

import { NextRequest, NextResponse } from "next/server";
import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import { sessionOptions, type SessionData } from "@/lib/session/cookie";
import { checkAllLimits } from "@/lib/ratelimit";
import { cloudAiDisabled, hasAnyChatProvider } from "@/lib/env";
import { cloudPlannerJson } from "@/lib/providers/cloud";
import { extractJsonObject } from "@/lib/util/safeJson";
import { newId } from "@/lib/util/id";
import {
  parseChatBrainIntent,
  payloadHasForbiddenKeys,
  type ChatBrainIntent
} from "@/lib/llm/chatBrainSchema";

export const runtime = "nodejs";

interface WarmupResponse {
  status: "ready" | "unavailable";
}
interface ResolveResponse {
  intent: ChatBrainIntent | null;
  /** Present only when the brain is unavailable, for client logging. */
  unavailable?: boolean;
}

const RESOLVE_SYSTEM_PROMPT = [
  "You are the intent router for a browser-first AI video editor.",
  "You ONLY receive compact text state — never video, frames, audio, or transcripts.",
  "Classify the user's latest message into ONE route and extract any editing slots you can.",
  "If a pendingQuestion is present, decide whether the message ANSWERS it (set answersPendingQuestion + route 'answer_pending_question').",
  "",
  "Return STRICT JSON ONLY (no prose, no markdown) matching this TypeScript type:",
  "{",
  '  "route": "answer_pending_question" | "describe_video" | "create_highlight" | "refine_timeline" | "trim_to_target" | "read_only" | "confirm_pending" | "cancel_pending" | "passthrough" | "ask_clarifying_question",',
  '  "confidence": number,            // 0..1',
  '  "outputType"?: "best_moments_reel" | "one_continuous_short" | "specific_scene" | "merge_as_is" | "unknown",',
  '  "sourceScope"?: "current_video" | "current_timeline" | "selected_videos" | "all_uploaded" | "unspecified",',
  '  "contentFocus"?: string[],       // user topics, e.g. ["travel","places"]',
  '  "includeConcepts"?: string[],',
  '  "excludeConcepts"?: string[],',
  '  "targetSeconds"?: number | null,',
  '  "style"?: string | null,',
  '  "answersPendingQuestion"?: boolean,',
  '  "pendingQuestionId"?: string | null,',
  '  "shouldAsk"?: boolean,',
  '  "askMessage"?: string | null,   // one short useful question if shouldAsk',
  '  "suggestions"?: string[],',
  '  "normalizedUserText": string,   // typo-fixed, e.g. "one continuos" -> "one continuous"',
  '  "reason": string',
  "}",
  "Rules: never invent on-screen content you cannot know from text; prefer 'passthrough' when unsure; keep contentFocus to the user's own words."
].join("\n");

async function rateLimited(): Promise<boolean> {
  try {
    const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
    if (!session.sid) {
      session.sid = newId("u");
      session.createdAt = Date.now();
      await session.save();
    }
    const rl = await checkAllLimits({ sid: session.sid, scope: "agent", consumesLlm: true });
    return !rl.allowed;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Defense in depth: never accept media/secret-shaped keys.
  if (payloadHasForbiddenKeys(body)) {
    return NextResponse.json({ error: "Payload contains disallowed fields" }, { status: 400 });
  }

  const task = typeof body.task === "string" ? body.task : "";

  // ---- WARMUP ------------------------------------------------------------
  if (task === "warmup") {
    if (cloudAiDisabled() || !hasAnyChatProvider()) {
      return NextResponse.json<WarmupResponse>({ status: "unavailable" });
    }
    if (await rateLimited()) {
      // Don't fail — just report not-ready so the client retries later.
      return NextResponse.json<WarmupResponse>({ status: "unavailable" });
    }
    try {
      // Tiny, cheap request that primes the provider connection.
      await cloudPlannerJson(
        'Reply with strict JSON only: {"ok":true}',
        '{"task":"warmup"}',
        { temperature: 0 }
      );
      return NextResponse.json<WarmupResponse>({ status: "ready" });
    } catch {
      return NextResponse.json<WarmupResponse>({ status: "unavailable" });
    }
  }

  // ---- RESOLVE -----------------------------------------------------------
  if (task === "resolve") {
    if (cloudAiDisabled() || !hasAnyChatProvider()) {
      return NextResponse.json<ResolveResponse>({ intent: null, unavailable: true });
    }
    if (await rateLimited()) {
      return NextResponse.json<ResolveResponse>({ intent: null, unavailable: true });
    }
    // The body itself is the privacy-safe payload (already forbidden-key
    // checked). Serialize it as the user content for the model.
    const userContent = JSON.stringify(body).slice(0, 4000);
    try {
      const result = await cloudPlannerJson(RESOLVE_SYSTEM_PROMPT, userContent, {
        temperature: 0
      });
      const parsed = extractJsonObject<Record<string, unknown>>(result.raw);
      const intent = parseChatBrainIntent(parsed);
      return NextResponse.json<ResolveResponse>({ intent });
    } catch {
      // Any provider failure → null (client falls back to deterministic).
      return NextResponse.json<ResolveResponse>({ intent: null, unavailable: true });
    }
  }

  return NextResponse.json({ error: "Unknown task" }, { status: 400 });
}

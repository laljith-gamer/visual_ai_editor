import { NextRequest, NextResponse } from "next/server";
import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import { sessionOptions, type SessionData } from "@/lib/session/cookie";
import { checkAllLimits } from "@/lib/ratelimit";
import { hasOpenRouter } from "@/lib/env";
import { openrouterAudioJson } from "@/lib/providers/openrouter";
import { extractJsonObject } from "@/lib/util/safeJson";
import { newId } from "@/lib/util/id";
import type { RateLimitDecision } from "@/lib/types";

export const runtime = "nodejs";

interface RequestBody {
  /** Base64 WAV (mono 16 kHz, no data: prefix). */
  audioBase64: string;
  /** Container format hint for the model. */
  format?: string;
  /** Audio length in seconds — only used to bound the prompt. */
  durationSeconds?: number;
}

interface CloudSegment {
  start: number;
  end: number;
  text: string;
}

const SYSTEM = `You are a precise speech-to-text transcriber. Transcribe the spoken audio verbatim.
Return JSON ONLY in this exact shape:
{ "language": "<iso code, e.g. en>", "segments": [ { "start": <seconds>, "end": <seconds>, "text": "<verbatim words>" } ] }
Rules:
- start/end are seconds from the beginning of the audio; end > start.
- Split into natural short segments (roughly one sentence or breath group each).
- Do NOT translate, summarize, censor, or add commentary. Empty audio → { "segments": [] }.`;

/**
 * Cloud transcription. Used ONLY when the user enabled the cloud-analysis
 * toggle. Routes audio to a free OpenRouter analysis model that accepts audio
 * input and returns timestamped speech segments — faster than downloading +
 * running on-device Whisper, especially on low-tier devices.
 *
 * The client always keeps on-device Whisper as the guaranteed fallback
 * (OFFLINE EDIT principle): if this route is unconfigured (503) or errors
 * (502), the client transparently falls back and the assistant says so.
 *
 * Privacy: only the extracted mono 16 kHz audio of a file the user already
 * uploaded is sent; full video bytes never leave the browser, and the audio
 * is never logged.
 */
export async function POST(req: NextRequest) {
  // Audio input is reliably supported via OpenRouter multimodal models only,
  // so this route requires OpenRouter specifically (not the Gemini-direct
  // vision fallback, whose OpenAI-compat shim here is text/image-only).
  if (!hasOpenRouter()) {
    return NextResponse.json(
      { error: "Cloud transcription unavailable" },
      { status: 503 }
    );
  }

  const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
  if (!session.sid) {
    session.sid = newId("u");
    session.createdAt = Date.now();
    await session.save();
  }

  // Dispatcher-backed analysis scope — omit `provider` so the OpenRouter
  // client's own retry/circuit handling isn't pre-empted by a route fast-fail.
  const rl = await checkAllLimits({
    sid: session.sid,
    scope: "vision-window",
    consumesLlm: true
  });
  if (!rl.allowed) {
    return rateLimitResponse(rl);
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.audioBase64 !== "string" || body.audioBase64.length === 0) {
    return NextResponse.json({ error: "Bad payload" }, { status: 400 });
  }

  const format = body.format ?? "wav";
  const durationHint =
    typeof body.durationSeconds === "number" && body.durationSeconds > 0
      ? `The audio is about ${Math.round(body.durationSeconds)} seconds long.`
      : "";

  try {
    const raw = await openrouterAudioJson(
      `${SYSTEM}\n\n${durationHint}`.trim(),
      { base64: body.audioBase64, format },
      { temperature: 0 }
    );
    const parsed = extractJsonObject<{
      language?: string;
      segments?: CloudSegment[];
    }>(raw);

    const segments = normalizeSegments(parsed?.segments);
    const fullText = segments
      .map((s) => s.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    return NextResponse.json({
      language: typeof parsed?.language === "string" ? parsed.language : "en",
      segments,
      fullText
    });
  } catch {
    // Surface a distinct status so the client knows to fall back to Whisper.
    return NextResponse.json(
      { error: "Cloud transcription failed", transient: true },
      { status: 502 }
    );
  }
}

/** Clamp/validate model output into clean {start,end,text} segments. */
function normalizeSegments(input: CloudSegment[] | undefined): CloudSegment[] {
  if (!Array.isArray(input)) return [];
  const out: CloudSegment[] = [];
  for (const seg of input) {
    const start = Number(seg?.start);
    let end = Number(seg?.end);
    const text = typeof seg?.text === "string" ? seg.text.trim() : "";
    if (!text) continue;
    if (!Number.isFinite(start) || start < 0) continue;
    if (!Number.isFinite(end) || end <= start) end = start + 1;
    out.push({ start, end, text });
  }
  // Keep chronological order so downstream timing assumptions hold.
  out.sort((a, b) => a.start - b.start);
  return out;
}

function rateLimitResponse(rl: RateLimitDecision): NextResponse {
  const status = rl.status ?? 429;
  return NextResponse.json(
    {
      error:
        rl.reason === "global_budget"
          ? "Daily AI capacity reached for shared cloud transcription."
          : "Rate limit exceeded.",
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

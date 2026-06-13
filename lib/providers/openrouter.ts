// =====================================================================
// lib/providers/openrouter.ts
//
// SERVER-SIDE OpenRouter client (OpenAI-compatible chat completions).
//
// OpenRouter is the primary cloud model provider for language + tool
// routing (and, when the configured model is multimodal, vision). It
// replaces the removed in-browser WebLLM path.
//
// SECURITY (hard rules):
//   - The API key is read from process.env.OPENROUTER_API_KEY via
//     lib/env.ts and is SERVER-ONLY. It is NEVER sent to the browser and
//     there is intentionally no NEXT_PUBLIC_OPENROUTER_API_KEY.
//   - This module must only ever be imported by server code (API routes /
//     other server modules), never by a client component.
//   - We never console.log prompts, user text, API keys, base64 frame
//     data, or video bytes. Errors log a short status only.
//
// JSON handling:
//   - We request OpenAI-style JSON object mode (response_format:
//     { type: "json_object" }) by default; the default model
//     (google/gemini-2.5-flash) supports it. Callers ALSO parse the
//     returned text with extractJsonObject() as a defensive fallback for
//     models/edge-cases that wrap or pad the JSON. Structured json_schema
//     output can be layered on later via opts.responseFormat without
//     changing callers.
//
// No new dependency: uses the runtime fetch (Node 20 / Next server).
// =====================================================================

import { serverEnv } from "@/lib/env";
import { OPENROUTER } from "@/lib/config";

/** Resolve the API key or throw a safe error (never logs the key). */
function apiKey(): string {
  const key = serverEnv.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  return key;
}

/** Build request headers. HTTP-Referer is sent only when an app URL is
 *  configured; X-Title labels traffic in the OpenRouter dashboard. */
function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey()}`,
    "Content-Type": "application/json",
    "X-Title": OPENROUTER.appTitle
  };
  if (serverEnv.APP_URL) headers["HTTP-Referer"] = serverEnv.APP_URL;
  return headers;
}

// ---- Model resolvers (env override → config default) ----------------
export function defaultModel(): string {
  return serverEnv.OPENROUTER_DEFAULT_MODEL ?? OPENROUTER.defaultModel;
}
export function cheapModel(): string {
  return serverEnv.OPENROUTER_CHEAP_MODEL ?? OPENROUTER.cheapModel;
}
export function premiumModel(): string {
  return serverEnv.OPENROUTER_PREMIUM_MODEL ?? OPENROUTER.premiumModel;
}
export function ossModel(): string {
  return serverEnv.OPENROUTER_OSS_MODEL ?? OPENROUTER.ossModel;
}

/**
 * The ABSOLUTE ceiling for any single OpenRouter request's max_tokens.
 *
 * Resolves the OPENROUTER_MAX_TOKENS env override → OPENROUTER.hardMaxTokens
 * (2048). This is the one knob that can raise the cap, and it is a deliberate,
 * server-only config value (never a client/NEXT_PUBLIC secret). Without a cap,
 * OpenRouter reserves credits for the model's full output window and rejects
 * low-credit accounts with HTTP 402. A positive, finite integer is required;
 * anything else falls back to the config ceiling.
 */
export function hardMaxTokens(): number {
  const raw = serverEnv.OPENROUTER_MAX_TOKENS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : OPENROUTER.hardMaxTokens;
}

/**
 * Clamp a requested max_tokens to the hard ceiling, applying a safe default
 * when the caller didn't specify one. This GUARANTEES we never send a giant
 * value (e.g. the model's 65535 window) to OpenRouter — the root cause of the
 * 402 "requested up to 65535 tokens, but can only afford 16000" error.
 *
 * @param requested  explicit max_tokens from the caller (optional)
 * @param fallback   call-type default when `requested` is absent
 */
function clampMaxTokens(requested: number | undefined, fallback: number): number {
  const cap = hardMaxTokens();
  const wanted =
    typeof requested === "number" && Number.isFinite(requested) && requested > 0
      ? requested
      : fallback;
  return Math.min(wanted, cap);
}

/**
 * Heuristic: is this error worth retrying? Mirrors the Gemini classifier so
 * a transient OpenRouter overload (HTTP 429/5xx) or network blip is retried
 * rather than surfaced to the user. Errors thrown by attemptCompletion()
 * include the bracketed status (e.g. "[503 ...]"), and network failures carry
 * a recognisable message. Auth/quota/validation errors (400/401/402/403) are
 * intentionally NOT matched, so we never burn retries on a request that can
 * never succeed (e.g. the 402 "insufficient credits" case).
 */
function isRetryableError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? String(err);
  if (/\[(?:429|500|502|503|504)\b/.test(msg)) return true;
  if (/high demand|overloaded|temporarily|please try again|rate.?limit/i.test(msg))
    return true;
  if (/timeout|ETIMEDOUT|ECONNRESET|fetch failed|network/i.test(msg)) return true;
  return false;
}

/** Sleep helper for backoff. */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------
// Message shapes (OpenAI-compatible)
// ---------------------------------------------------------------------

type TextPart = { type: "text"; text: string };
type ImagePart = { type: "image_url"; image_url: { url: string } };
type Content = string | Array<TextPart | ImagePart>;

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: Content;
}

export interface OpenRouterOptions {
  /** Model slug override; defaults to OPENROUTER default model. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Set false to omit response_format (some models reject json_object). */
  jsonMode?: boolean;
  /** Call-type default for max_tokens when `maxTokens` is unset. Internal:
   *  set by openrouterJson (planner) / openrouterMultiImageJson (vision).
   *  Always clamped to the hard ceiling regardless. */
  fallbackMaxTokens?: number;
}

/**
 * Low-level completion with transient-error retry. Returns the assistant
 * message content string. Throws on non-2xx with a message that includes the
 * bracketed status so the shared isTransientError() classifier can detect
 * 429/5xx. Never logs the prompt, images, or key.
 *
 * Transient failures (overload/429/5xx/network) are retried with exponential
 * backoff + jitter up to OPENROUTER.retryAttempts. This is what stops a brief
 * "model temporarily overloaded" blip from reaching the user when there is no
 * cross-provider fallback configured. An aborted request is never retried.
 */
async function createCompletion(
  messages: ChatMessage[],
  opts: OpenRouterOptions
): Promise<string> {
  const attempts = Math.max(1, OPENROUTER.retryAttempts);
  const baseDelay = OPENROUTER.retryBaseDelayMs;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await attemptCompletion(messages, opts);
    } catch (err) {
      lastErr = err;
      // Never retry a caller-cancelled request.
      if (opts.signal?.aborted) throw err;
      const isLastAttempt = attempt === attempts - 1;
      if (isLastAttempt || !isRetryableError(err)) throw err;
      const delay = baseDelay * 2 ** attempt + Math.random() * 200;
      await sleep(delay);
    }
  }
  // Unreachable (the loop either returns or throws), but satisfies the type.
  throw lastErr instanceof Error
    ? lastErr
    : new Error(String(lastErr ?? "OpenRouter request failed"));
}

/**
 * A single OpenRouter request attempt (no retry). Split out of
 * createCompletion so the retry loop can call it repeatedly.
 */
async function attemptCompletion(
  messages: ChatMessage[],
  opts: OpenRouterOptions
): Promise<string> {
  const model = opts.model ?? defaultModel();
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts.temperature ?? OPENROUTER.temperature,
    // ALWAYS clamp: a caller may pass a large value, or none at all. Either
    // way the request can never exceed the hard ceiling, so we never send
    // 65535 and never 402 on a tight credit budget.
    max_tokens: clampMaxTokens(
      opts.maxTokens,
      opts.fallbackMaxTokens ?? OPENROUTER.plannerMaxTokens
    )
  };
  if (opts.jsonMode ?? true) body.response_format = { type: "json_object" };

  let res: Response;
  try {
    res = await fetch(OPENROUTER.endpoint, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify(body),
      signal: opts.signal
    });
  } catch (err) {
    // Network-level failure (DNS / reset / abort). Re-throw with a message
    // the transient classifier recognises; no prompt/image data included.
    throw new Error(
      `OpenRouter request failed (network): ${(err as Error)?.message ?? "fetch failed"}`
    );
  }

  if (!res.ok) {
    // Read a SHORT error detail if present. OpenRouter error bodies describe
    // the request status; they do not echo our prompt/images. We still cap
    // the length and never log it here (the caller logs safely).
    let detail = "";
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      if (typeof j?.error?.message === "string") {
        detail = `: ${j.error.message.slice(0, 200)}`;
      }
    } catch {
      // ignore unparseable error bodies
    }
    throw new Error(
      `OpenRouter request failed [${res.status} ${res.statusText}]${detail}`
    );
  }

  let data: { choices?: Array<{ message?: { content?: unknown } }> };
  try {
    data = await res.json();
  } catch (err) {
    throw new Error(
      `OpenRouter returned unparseable JSON envelope: ${(err as Error)?.message ?? "parse error"}`
    );
  }
  const content = data?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

// ---------------------------------------------------------------------
// Public: text JSON completion (planner / agent route)
// ---------------------------------------------------------------------

/**
 * Text-only JSON call. Mirrors geminiJson(system, user) so the cloud
 * dispatcher can use providers interchangeably. Returns the raw model text
 * (caller parses with extractJsonObject).
 */
export async function openrouterJson(
  system: string,
  user: string,
  options: OpenRouterOptions = {}
): Promise<string> {
  return createCompletion(
    [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    // Planner/chat/edit-command JSON is small; default to the planner cap
    // (still hard-clamped to the ceiling inside attemptCompletion).
    { fallbackMaxTokens: OPENROUTER.plannerMaxTokens, ...options }
  );
}

// ---------------------------------------------------------------------
// Public: multi-image (vision) JSON completion (briefing / clip routes)
// ---------------------------------------------------------------------

/**
 * Vision JSON call. Takes ONE combined text prompt + N inline images and
 * mirrors geminiMultiImageJson() so vision routes can swap providers.
 *
 * Images are passed as OpenAI-style data: URLs. Only works when the
 * configured model is multimodal (the default google/gemini-2.5-flash is);
 * with a text-only model the request will error and the dispatcher falls
 * back to direct Gemini.
 *
 * NOTE: the base64 frame data lives in the request body only — it is NEVER
 * logged. These are already-sampled frames; full video bytes never leave
 * the browser.
 */
export async function openrouterMultiImageJson(
  prompt: string,
  images: Array<{ base64: string; mimeType?: string }>,
  options: OpenRouterOptions = {}
): Promise<string> {
  if (images.length === 0) {
    throw new Error("openrouterMultiImageJson called with zero images");
  }
  const content: Array<TextPart | ImagePart> = [
    { type: "text", text: prompt },
    ...images.map<ImagePart>((img) => ({
      type: "image_url",
      image_url: {
        url: `data:${img.mimeType ?? "image/jpeg"};base64,${img.base64}`
      }
    }))
  ];
  // Vision/briefing JSON gets a little more headroom than the planner; still
  // hard-clamped to the ceiling inside attemptCompletion.
  return createCompletion([{ role: "user", content }], {
    fallbackMaxTokens: OPENROUTER.visionMaxTokens,
    ...options
  });
}

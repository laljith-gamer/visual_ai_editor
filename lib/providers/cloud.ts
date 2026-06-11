// =====================================================================
// lib/providers/cloud.ts
//
// SERVER-SIDE cloud provider DISPATCHER.
//
// Walks CLOUD_PROVIDER_ORDER (config) and uses the first provider whose
// key is configured, falling back to the next on failure. This is the
// single place the app decides "which cloud model answers this turn":
//
//   OpenRouter (if OPENROUTER_API_KEY)
//     → Gemini direct (if GEMINI_API_KEY)
//       → Groq (text only; if GROQ_API_KEY)
//
// Why a dispatcher: the browser WebLLM path was removed, so language/tool
// routing is now cloud-only. Keeping Gemini/Groq as fallbacks means an
// OpenRouter outage (or no OpenRouter key) degrades gracefully instead of
// breaking the app.
//
// Circuit breaker (owned HERE, not at the route): before attempting, we
// SKIP any provider whose circuit is open and move to the next configured
// provider, then record success/failure on THAT provider's circuit. This is
// what lets an OpenRouter outage (open circuit) fall back to Gemini/Groq
// instead of the route returning 503 up front. Routes must therefore NOT do
// a blocking provider-circuit pre-check (see lib/ratelimit/index.ts).
//
// Privacy/security: providers themselves never log prompts/keys/images.
// Full video bytes never leave the browser — vision calls carry only the
// already-sampled frames the client chose to send.
// =====================================================================

import { hasGemini, hasOpenRouter, serverEnv } from "@/lib/env";
import {
  checkCircuit,
  recordFailure,
  recordSuccess,
  type Provider
} from "@/lib/ratelimit";
import { CLOUD_PROVIDER_ORDER } from "@/lib/config";
import { geminiJson, geminiMultiImageJson } from "@/lib/providers/gemini";
import { groqJson } from "@/lib/providers/groq";
import {
  openrouterJson,
  openrouterMultiImageJson
} from "@/lib/providers/openrouter";

export interface CloudJsonResult {
  /** Raw model text — caller parses with extractJsonObject(). */
  raw: string;
  /** Which provider actually produced the result. */
  provider: Provider;
  /** True when a non-primary provider answered (caller may surface a note). */
  usedFallback: boolean;
}

interface TextOptions {
  temperature?: number;
}
interface VisionOptions {
  temperature?: number;
  maxOutputTokens?: number;
}

function groqConfigured(): boolean {
  return Boolean(serverEnv.GROQ_API_KEY);
}

/** Providers available for this request, in preference order. Groq is
 *  text-only, so it is excluded from vision requests. */
function providerOrder(opts: { vision: boolean }): Provider[] {
  const available: Record<Provider, boolean> = {
    openrouter: hasOpenRouter(),
    gemini: hasGemini(),
    groq: opts.vision ? false : groqConfigured()
  };
  return CLOUD_PROVIDER_ORDER.filter(
    (p): p is Provider => available[p as Provider]
  );
}

/** The provider the app prefers right now (first available in order). Used
 *  for fallback messaging. NOTE: this is NOT used to gate the request — the
 *  dispatcher attempts the full circuit-filtered order regardless, so a
 *  circuit-open primary never blocks the Gemini/Groq fallback. */
export function primaryProvider(opts: { vision?: boolean } = {}): Provider {
  const order = providerOrder({ vision: opts.vision ?? false });
  return order[0] ?? "gemini";
}

/**
 * The configured provider order, filtered by circuit state: providers whose
 * circuit is OPEN are skipped so we don't waste a call on a known-down
 * provider and instead fall straight through to the next one.
 *
 * If EVERY configured provider's circuit is open, we return the full
 * configured order as a best-effort last resort (each attempt still records
 * success/failure, so a recovered provider closes its own circuit and the
 * system self-heals) rather than failing the request outright.
 *
 * Returns empty ONLY when no provider is configured for this request type.
 */
async function attemptableOrder(opts: { vision: boolean }): Promise<Provider[]> {
  const configured = providerOrder(opts);
  // Nothing to skip toward — return as-is (best-effort even if its circuit
  // is open, since there is no alternative to fall back to).
  if (configured.length <= 1) return configured;

  const states = await Promise.all(
    configured.map(async (p) => {
      try {
        const c = await checkCircuit(p);
        return { provider: p, closed: c.closed };
      } catch {
        // If circuit state can't be read, treat the provider as attemptable.
        return { provider: p, closed: true };
      }
    })
  );
  const closed = states.filter((s) => s.closed).map((s) => s.provider);
  return closed.length > 0 ? closed : configured;
}

/**
 * Text JSON completion with provider fallback. Used by /api/agent for the
 * planner. Throws the LAST error only when every available provider fails,
 * so the caller's existing transient-error handling still works.
 */
export async function cloudPlannerJson(
  system: string,
  user: string,
  options: TextOptions = {}
): Promise<CloudJsonResult> {
  const order = await attemptableOrder({ vision: false });
  if (order.length === 0) throw new Error("No chat provider configured");

  let lastErr: unknown = null;
  for (let i = 0; i < order.length; i++) {
    const provider = order[i];
    try {
      const raw = await callText(provider, system, user, options);
      await recordSuccess(provider).catch(() => {});
      return { raw, provider, usedFallback: i > 0 };
    } catch (err) {
      lastErr = err;
      await recordFailure(provider).catch(() => {});
      // try the next provider in the chain
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(String(lastErr ?? "All chat providers failed"));
}

/**
 * Vision (multi-image) JSON completion with provider fallback. Used by the
 * briefing + clip routes. OpenRouter is used only when its configured model
 * is multimodal (the default is); otherwise it errors and we fall back to
 * direct Gemini. Throws the last error when every vision provider fails.
 */
export async function cloudVisionJson(
  prompt: string,
  images: Array<{ base64: string; mimeType?: string }>,
  options: VisionOptions = {}
): Promise<CloudJsonResult> {
  const order = await attemptableOrder({ vision: true });
  if (order.length === 0) throw new Error("No vision provider configured");

  let lastErr: unknown = null;
  for (let i = 0; i < order.length; i++) {
    const provider = order[i];
    try {
      const raw = await callVision(provider, prompt, images, options);
      await recordSuccess(provider).catch(() => {});
      return { raw, provider, usedFallback: i > 0 };
    } catch (err) {
      lastErr = err;
      await recordFailure(provider).catch(() => {});
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(String(lastErr ?? "All vision providers failed"));
}

// ---------------------------------------------------------------------
// Per-provider adapters
// ---------------------------------------------------------------------

function callText(
  provider: Provider,
  system: string,
  user: string,
  options: TextOptions
): Promise<string> {
  switch (provider) {
    case "openrouter":
      return openrouterJson(system, user, { temperature: options.temperature });
    case "gemini":
      return geminiJson(system, user, { temperature: options.temperature });
    case "groq":
      return groqJson(system, user, { temperature: options.temperature });
  }
}

function callVision(
  provider: Provider,
  prompt: string,
  images: Array<{ base64: string; mimeType?: string }>,
  options: VisionOptions
): Promise<string> {
  switch (provider) {
    case "openrouter":
      return openrouterMultiImageJson(prompt, images, {
        temperature: options.temperature,
        maxTokens: options.maxOutputTokens
      });
    case "gemini":
      return geminiMultiImageJson(prompt, images, {
        temperature: options.temperature,
        maxOutputTokens: options.maxOutputTokens
      });
    case "groq":
      // Groq is text-only; providerOrder excludes it for vision. Guard
      // anyway so the switch is exhaustive.
      throw new Error("Groq does not support vision input");
  }
}

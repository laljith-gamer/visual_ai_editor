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
// Circuit breaker: each attempt records success/failure on THAT provider's
// circuit (recordSuccess/recordFailure), so a flapping provider opens its
// own circuit without affecting the others. The coarse pre-check in the
// route (checkAllLimits) targets the primary provider.
//
// Privacy/security: providers themselves never log prompts/keys/images.
// Full video bytes never leave the browser — vision calls carry only the
// already-sampled frames the client chose to send.
// =====================================================================

import { hasGemini, hasOpenRouter, serverEnv } from "@/lib/env";
import { recordFailure, recordSuccess, type Provider } from "@/lib/ratelimit";
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
 *  by routes for the coarse circuit pre-check + fallback messaging. */
export function primaryProvider(opts: { vision?: boolean } = {}): Provider {
  const order = providerOrder({ vision: opts.vision ?? false });
  return order[0] ?? "gemini";
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
  const order = providerOrder({ vision: false });
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
  const order = providerOrder({ vision: true });
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

// =====================================================================
// lib/providers/cloud.ts
//
// SERVER-SIDE cloud provider DISPATCHER.
//
// Walks the provider preference order and uses the first provider whose
// key is configured, falling back to the next on failure. This is the
// single place the app decides "which cloud model answers this turn".
//
// Default order remains OpenRouter → Gemini → Groq. Deployments can override
// the order with CLOUD_PROVIDER_ORDER. A custom OpenAI-compatible provider is
// also supported for non-OpenRouter gateways when explicitly configured.
//
// Privacy/security: providers themselves never log prompts/keys/images.
// Full video bytes never leave the browser — vision calls carry only the
// already-sampled frames the client chose to send.
// =====================================================================

import { hasCustomOpenAI, hasGemini, hasOpenRouter, serverEnv } from "@/lib/env";
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
import {
  customOpenaiJson,
  customOpenaiMultiImageJson,
  customOpenaiVisionEnabled
} from "@/lib/providers/customOpenai";

type CloudProvider = Provider | "custom_openai";

export interface CloudJsonResult {
  /** Raw model text — caller parses with extractJsonObject(). */
  raw: string;
  /** Which provider actually produced the result. */
  provider: CloudProvider;
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

/** All known provider names, used to validate the env override. */
const VALID_PROVIDERS: readonly CloudProvider[] = [
  "openrouter",
  "custom_openai",
  "gemini",
  "groq"
];

function defaultOrder(): readonly CloudProvider[] {
  return CLOUD_PROVIDER_ORDER;
}

/**
 * The effective provider PREFERENCE ORDER (before availability filtering).
 *
 * Reads optional CLOUD_PROVIDER_ORDER (server-only, comma-separated), e.g.:
 *   CLOUD_PROVIDER_ORDER=custom_openai        → custom provider only
 *   CLOUD_PROVIDER_ORDER=custom_openai,gemini → custom first, Gemini fallback
 *   CLOUD_PROVIDER_ORDER=gemini               → Gemini only
 *   CLOUD_PROVIDER_ORDER=openrouter           → OpenRouter only
 */
function configuredOrder(): readonly CloudProvider[] {
  const raw = serverEnv.CLOUD_PROVIDER_ORDER;
  if (!raw) return defaultOrder();

  const seen = new Set<CloudProvider>();
  const parsed: CloudProvider[] = [];
  for (const token of raw.split(",")) {
    const name = token.trim().toLowerCase();
    if (
      (VALID_PROVIDERS as readonly string[]).includes(name) &&
      !seen.has(name as CloudProvider)
    ) {
      seen.add(name as CloudProvider);
      parsed.push(name as CloudProvider);
    }
  }
  return parsed.length > 0 ? parsed : defaultOrder();
}

/** Providers available for this request, in preference order. Groq is
 *  text-only. Custom OpenAI-compatible vision is opt-in because not every
 *  compatible gateway accepts image_url content. */
function providerOrder(opts: { vision: boolean }): CloudProvider[] {
  const available: Record<CloudProvider, boolean> = {
    openrouter: hasOpenRouter(),
    custom_openai: hasCustomOpenAI() && (!opts.vision || customOpenaiVisionEnabled()),
    gemini: hasGemini(),
    groq: opts.vision ? false : groqConfigured()
  };
  return configuredOrder().filter(
    (p): p is CloudProvider => available[p as CloudProvider]
  );
}

/** The provider the app prefers right now (first available in order). Used
 *  for fallback messaging. */
export function primaryProvider(opts: { vision?: boolean } = {}): CloudProvider {
  const order = providerOrder({ vision: opts.vision ?? false });
  return order[0] ?? "gemini";
}

/** Returns configured providers after skipping open circuits when there is
 *  more than one choice. The custom provider is recorded under its own key via
 *  a string cast; the circuit store itself is string-keyed at runtime. */
async function attemptableOrder(opts: { vision: boolean }): Promise<CloudProvider[]> {
  const configured = providerOrder(opts);
  if (configured.length <= 1) return configured;

  const states = await Promise.all(
    configured.map(async (p) => {
      try {
        const c = await checkCircuit(p as Provider);
        return { provider: p, closed: c.closed };
      } catch {
        return { provider: p, closed: true };
      }
    })
  );
  const closed = states.filter((s) => s.closed).map((s) => s.provider);
  return closed.length > 0 ? closed : configured;
}

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
      await recordSuccess(provider as Provider).catch(() => {});
      return { raw, provider, usedFallback: i > 0 };
    } catch (err) {
      lastErr = err;
      await recordFailure(provider as Provider).catch(() => {});
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(String(lastErr ?? "All chat providers failed"));
}

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
      await recordSuccess(provider as Provider).catch(() => {});
      return { raw, provider, usedFallback: i > 0 };
    } catch (err) {
      lastErr = err;
      await recordFailure(provider as Provider).catch(() => {});
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(String(lastErr ?? "All vision providers failed"));
}

function callText(
  provider: CloudProvider,
  system: string,
  user: string,
  options: TextOptions
): Promise<string> {
  switch (provider) {
    case "openrouter":
      return openrouterJson(system, user, { temperature: options.temperature });
    case "custom_openai":
      return customOpenaiJson(system, user, { temperature: options.temperature });
    case "gemini":
      return geminiJson(system, user, { temperature: options.temperature });
    case "groq":
      return groqJson(system, user, { temperature: options.temperature });
  }
}

function callVision(
  provider: CloudProvider,
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
    case "custom_openai":
      return customOpenaiMultiImageJson(prompt, images, {
        temperature: options.temperature,
        maxTokens: options.maxOutputTokens
      });
    case "gemini":
      return geminiMultiImageJson(prompt, images, {
        temperature: options.temperature,
        maxOutputTokens: options.maxOutputTokens
      });
    case "groq":
      throw new Error("Groq does not support vision input");
  }
}

import { GoogleGenerativeAI, type GenerativeModel } from "@google/generative-ai";
import { serverEnv } from "@/lib/env";

/**
 * Gemini wrapper with two layers of resilience:
 *
 *  1. Retry transient errors (503, 429, 500, 502, 504, network) up to N times
 *     per model with exponential backoff.
 *  2. If a whole model is overloaded, fall through to the next model in the
 *     chain. Models share the same key + free tier and all support
 *     responseMimeType="application/json", so this is transparent to callers.
 *
 * The chain begins with whatever GEMINI_MODEL is set to (default
 * "gemini-2.5-flash"), then walks down a curated list of widely available,
 * faster, lower-demand siblings. The very first model that returns 200 wins.
 */

let client: GoogleGenerativeAI | null = null;
const modelCache = new Map<string, GenerativeModel>();

function getClient(): GoogleGenerativeAI {
  if (!serverEnv.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  if (!client) client = new GoogleGenerativeAI(serverEnv.GEMINI_API_KEY);
  return client;
}

function getModel(name: string): GenerativeModel {
  const cached = modelCache.get(name);
  if (cached) return cached;
  const m = getClient().getGenerativeModel({
    model: name,
    generationConfig: {
      temperature: 0.4,
      responseMimeType: "application/json"
    }
  });
  modelCache.set(name, m);
  return m;
}

/**
 * The fallback chain. Order matters — first hit wins. We dedupe so the env-var
 * primary appears once, even if it's already in the default fallback list.
 */
function modelChain(): string[] {
  const primary = serverEnv.GEMINI_MODEL; // default "gemini-2.5-flash"
  const fallbacks = [
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite"
  ];
  const seen = new Set<string>();
  return [primary, ...fallbacks].filter((name) => {
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

/** Heuristic for "this error is probably temporary, worth retrying". */
function isTransientError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? String(err);
  // Gemini SDK formats errors like "[503 Service Unavailable]"
  if (/\[(?:429|500|502|503|504)\b/.test(msg)) return true;
  if (/high demand|overloaded|temporarily|please try again/i.test(msg)) return true;
  if (/timeout|ETIMEDOUT|ECONNRESET|fetch failed|network/i.test(msg)) return true;
  return false;
}

/** Sleep helper. */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn(modelName)` against each model in the fallback chain. Within a
 * single model, retry transient errors up to `attemptsPerModel` times with
 * exponential backoff. Throw the last error only if every model is exhausted.
 */
async function withFallback<T>(
  fn: (modelName: string) => Promise<T>,
  options: { attemptsPerModel?: number; baseDelayMs?: number } = {}
): Promise<T> {
  const attempts = options.attemptsPerModel ?? 2;
  const baseDelay = options.baseDelayMs ?? 600;
  const models = modelChain();
  let lastError: unknown = null;

  for (const name of models) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await fn(name);
      } catch (err) {
        lastError = err;
        const transient = isTransientError(err);
        if (!transient) throw err;
        const isLastAttemptOnThisModel = attempt === attempts - 1;
        if (!isLastAttemptOnThisModel) {
          // backoff with jitter
          const delay = baseDelay * 2 ** attempt + Math.random() * 200;
          await sleep(delay);
        }
        // else: fall through to the next model in the chain
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? "Gemini request failed"));
}

/** Text-only JSON call. */
export async function geminiJson(
  system: string,
  user: string,
  options: { temperature?: number } = {}
): Promise<string> {
  return withFallback(async (modelName) => {
    const model = getModel(modelName);
    const result = await model.generateContent({
      contents: [
        { role: "user", parts: [{ text: `${system}\n\n${user}` }] }
      ],
      generationConfig: {
        temperature: options.temperature ?? 0.4,
        responseMimeType: "application/json"
      }
    });
    return result.response.text();
  });
}

/** Vision (text + inline image) JSON call. */
export async function geminiVisionJson(
  prompt: string,
  imageBase64: string,
  mimeType = "image/jpeg",
  options: { temperature?: number } = {}
): Promise<string> {
  return withFallback(async (modelName) => {
    const model = getModel(modelName);
    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { mimeType, data: imageBase64 } }
          ]
        }
      ],
      generationConfig: {
        temperature: options.temperature ?? 0.2,
        responseMimeType: "application/json"
      }
    });
    return result.response.text();
  });
}

/** Re-export the classifier so the agent route can format friendlier errors. */
export { isTransientError };

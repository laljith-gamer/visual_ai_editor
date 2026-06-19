// =====================================================================
// lib/local-llm/webllm.ts
//
// LAZY in-browser WebLLM engine loader. The @mlc-ai/web-llm package is
// ONLY pulled in via a dynamic import() inside loadLocalEngine(), so it
// lives in its own code-split chunk and is NEVER part of the initial
// /editor bundle. It is fetched + the model downloaded ONLY when the
// local fallback actually runs (i.e. when the cloud planner fails and
// the feature is enabled). Nothing here executes on page load.
//
// HARD RULES:
//   - WebGPU is REQUIRED. We check up front and fail gracefully so the
//     manual editor keeps working when WebGPU is absent.
//   - TEXT ONLY. This engine does planner / edit-command JSON. It has NO
//     vision and must never be presented as able to describe frames.
//   - Fully on-device. No user data (and certainly no video) leaves the
//     browser via this path.
//
// Types are imported with `import type` (erased at build) so referencing
// them does not eagerly bundle the library.
// =====================================================================

import type {
  MLCEngineInterface,
  InitProgressReport
} from "@mlc-ai/web-llm";
import { LOCAL_LLM } from "./config";
import { setLocalAIStatus } from "./status";

/** True when the browser exposes a usable WebGPU adapter entry point.
 *  This is a cheap synchronous capability check (mirrors
 *  hooks/useCapability.ts `hasWebGPU`); it does NOT request an adapter. */
export function isWebGPUAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "gpu" in navigator &&
    Boolean((navigator as Navigator & { gpu?: unknown }).gpu)
  );
}

// Singleton engine promise, keyed by the model actually loaded. A second
// call with the same model reuses the in-flight/loaded engine; a failed
// load clears the cache so a later retry can start fresh.
let enginePromise: Promise<MLCEngineInterface> | null = null;
let loadedModel: string | null = null;
let engineReady = false;

/** True when the local engine has FINISHED loading and is ready to answer.
 *  Used by the read-only conversation lane to decide whether it can cheaply
 *  use the local model for classification/answers WITHOUT triggering a fresh
 *  multi-hundred-MB model download just for a question. */
export function isLocalEngineReady(): boolean {
  return engineReady;
}

/**
 * Load (or reuse) the local WebLLM engine for `model`. Reports download/
 * compile progress through the shared status store so the UI can show a
 * "Local AI loading…" indicator. Throws when WebGPU is unavailable or the
 * model fails to load — callers degrade gracefully.
 */
export async function loadLocalEngine(
  model: string = LOCAL_LLM.defaultModel
): Promise<MLCEngineInterface> {
  if (!isWebGPUAvailable()) {
    throw new Error("WebGPU is not available in this browser");
  }
  if (enginePromise && loadedModel === model) return enginePromise;

  loadedModel = model;
  setLocalAIStatus({
    mode: "local",
    phase: "loading",
    progress: 0,
    text: "Local AI loading\u2026"
  });

  enginePromise = (async () => {
    // Dynamic import → separate chunk, fetched only now.
    const webllm = await import("@mlc-ai/web-llm");
    const engine = await webllm.CreateMLCEngine(model, {
      initProgressCallback: (report: InitProgressReport) => {
        setLocalAIStatus({
          mode: "local",
          phase: "loading",
          progress: typeof report.progress === "number" ? report.progress : 0,
          text: report.text || "Local AI loading\u2026"
        });
      }
    });
    setLocalAIStatus({
      mode: "local",
      phase: "ready",
      progress: 1,
      text: "Local AI ready"
    });
    engineReady = true;
    return engine;
  })().catch((err) => {
    // Reset the cache so a later turn can retry from scratch.
    enginePromise = null;
    loadedModel = null;
    engineReady = false;
    setLocalAIStatus({
      phase: "error",
      progress: 0,
      text: "Local AI failed to load"
    });
    throw err;
  });

  return enginePromise;
}

/**
 * Run a single TEXT JSON completion on the local engine. Mirrors the
 * server providers' (system, user) → raw-string contract so the caller
 * can parse it with extractJsonObject(). Requests JSON-object mode; small
 * models still occasionally wrap output, hence the defensive parse upstream.
 */
export async function localChatJson(
  system: string,
  user: string,
  opts: { maxTokens?: number; temperature?: number } = {}
): Promise<string> {
  const engine = await loadLocalEngine();
  const completion = await engine.chat.completions.create({
    stream: false,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 1024,
    response_format: { type: "json_object" }
  });
  return completion.choices?.[0]?.message?.content ?? "";
}

/**
 * Run a single TEXT (free-form, NOT JSON) completion on the local engine.
 * Used by the read-only conversation lane to produce a natural explanation.
 * Read-only by contract: the caller's prompt forbids actions, and the answer
 * is sanity-checked upstream before use.
 */
export async function localChatText(
  system: string,
  user: string,
  opts: { maxTokens?: number; temperature?: number } = {}
): Promise<string> {
  const engine = await loadLocalEngine();
  const completion = await engine.chat.completions.create({
    stream: false,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.maxTokens ?? 320
  });
  return completion.choices?.[0]?.message?.content ?? "";
}

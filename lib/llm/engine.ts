// =====================================================================
// lib/llm/engine.ts
//
// Main-thread orchestrator for the LOCAL (WebGPU) language layer.
//
// Responsibilities:
//   - Gate on capability (WebGPU + Worker) and a master enable flag.
//   - Lazily create a WebWorkerMLCEngine and load the tier's model.
//   - Run a CONSTRAINED planning turn in JSON-mode and parse it
//     defensively into a LocalPlanResult.
//   - Never throw to callers: every failure becomes
//     { handled: false, reason } so the local-first chain can fall
//     through to the next layer (cloud, if configured).
//
// This module performs NO cloud calls. WebLLM downloads model artifacts
// from the HF CDN + raw.githubusercontent.com (model_lib .wasm) — see the
// CSP note in the PR. It deliberately does NOT import the cloud route.
// =====================================================================

import { LOCAL_LLM } from "@/lib/config";
import { extractJsonObject } from "@/lib/util/safeJson";
import type { CapabilityTier } from "@/lib/types";
import type {
  LocalChatMessage,
  LocalPlanOutcome,
  LocalPlannerContext,
  LocalPlanResult,
  LocalLlmProgress
} from "@/lib/llm/types";
import {
  LOCAL_PLANNER_SYSTEM_PROMPT,
  buildLocalPlannerUserPrompt
} from "@/lib/llm/prompt";

// ---------------------------------------------------------------------
// Capability + model selection
// ---------------------------------------------------------------------

/** Can the local LLM run here? Requires WebGPU + Worker. We only allow
 *  it on high/mid tiers (low-tier WebGPU devices struggle with a 1B+
 *  model and the download cost isn't worth it). */
export function isLocalLlmSupported(tier: CapabilityTier): boolean {
  if (typeof Worker === "undefined") return false;
  if (typeof navigator === "undefined" || !("gpu" in navigator)) return false;
  return tier === "high" || tier === "mid";
}

export function localModelForTier(tier: CapabilityTier): string {
  switch (tier) {
    case "high":
      return LOCAL_LLM.modelHigh;
    case "mid":
      return LOCAL_LLM.modelMid;
    default:
      return LOCAL_LLM.modelLow;
  }
}

/** The model id currently loaded into the engine, or null when none is
 *  loaded. Lets the chat UI show / switch the active model. */
export function loadedLocalModel(): string | null {
  return loadedModel;
}

/**
 * Ensure the engine is loaded for a SPECIFIC model id (not just a tier).
 * Used by the chat layer's model picker. Reuses the same singleton +
 * teardown-on-switch logic as the tier path. Returns the engine handle.
 *
 * Exported (vs. the private ensureEngine) so the chat module can drive
 * model selection directly while planLocally keeps its tier-based entry.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function ensureLocalEngine(opts: EnsureOptions): Promise<any> {
  return ensureEngine(opts);
}

// ---------------------------------------------------------------------
// Engine lifecycle (singleton)
// ---------------------------------------------------------------------

// We keep the type loose (`any`) for the engine handle because
// @mlc-ai/web-llm is an optional, lazily-imported dependency — importing
// its types eagerly would couple the whole app to it. The dynamic import
// inside ensureEngine() is the only place the package is referenced.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let enginePromise: Promise<any> | null = null;
let loadedModel: string | null = null;
let workerRef: Worker | null = null;

interface EnsureOptions {
  model: string;
  onProgress?: (p: LocalLlmProgress) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ensureEngine(opts: EnsureOptions): Promise<any> {
  if (enginePromise && loadedModel === opts.model) return enginePromise;

  // Model changed (tier switch) — tear down the old engine first.
  if (enginePromise) {
    await disposeLocalLlm();
  }

  loadedModel = opts.model;
  enginePromise = (async () => {
    // Dynamic import so the (large) package is only pulled when the local
    // path is actually exercised, and so a missing dep can't break SSR.
    const webllm = await import("@mlc-ai/web-llm");
    workerRef = new Worker(new URL("./webllm.worker.ts", import.meta.url), {
      type: "module"
    });
    return webllm.CreateWebWorkerMLCEngine(workerRef, opts.model, {
      initProgressCallback: (p: { progress: number; text: string }) => {
        opts.onProgress?.({ progress: p.progress, text: p.text });
      }
    });
  })();

  try {
    return await enginePromise;
  } catch (err) {
    // Reset so a later attempt can retry cleanly.
    enginePromise = null;
    loadedModel = null;
    if (workerRef) {
      workerRef.terminate();
      workerRef = null;
    }
    throw err;
  }
}

/** Tear down the local engine + worker, freeing the model from VRAM. */
export async function disposeLocalLlm(): Promise<void> {
  try {
    if (enginePromise) {
      const engine = await enginePromise.catch(() => null);
      // unload() is async in WebLLM; guard in case the API shifts.
      if (engine && typeof engine.unload === "function") {
        await engine.unload().catch(() => {});
      }
    }
  } finally {
    if (workerRef) {
      workerRef.terminate();
      workerRef = null;
    }
    enginePromise = null;
    loadedModel = null;
  }
}

// ---------------------------------------------------------------------
// Public: warm the model (optional, for a "download now" UX)
// ---------------------------------------------------------------------

export interface WarmOptions {
  tier: CapabilityTier;
  enabled?: boolean;
  onProgress?: (p: LocalLlmProgress) => void;
}

/** Preload + compile the tier's model so the first real turn is fast.
 *  Returns true when the engine is ready, false when unsupported/failed. */
export async function warmLocalLlm(opts: WarmOptions): Promise<boolean> {
  if (!(opts.enabled ?? false) || !isLocalLlmSupported(opts.tier)) return false;
  try {
    await ensureEngine({
      model: localModelForTier(opts.tier),
      onProgress: opts.onProgress
    });
    return true;
  } catch {
    await disposeLocalLlm();
    return false;
  }
}

// ---------------------------------------------------------------------
// Public: run a constrained planning turn
// ---------------------------------------------------------------------

export interface LocalPlanOptions {
  tier: CapabilityTier;
  /** Master switch. Default false (opt-in). */
  enabled?: boolean;
  messages: LocalChatMessage[];
  context?: LocalPlannerContext;
  onProgress?: (p: LocalLlmProgress) => void;
  signal?: AbortSignal;
}

/**
 * Attempt to plan the latest user turn locally. Returns { handled: false,
 * reason } whenever the local path can't or shouldn't answer, so the
 * caller falls through to the next layer in the chain.
 */
export async function planLocally(
  opts: LocalPlanOptions
): Promise<LocalPlanOutcome> {
  if (!(opts.enabled ?? false)) return { handled: false, reason: "disabled" };
  if (!isLocalLlmSupported(opts.tier)) {
    return { handled: false, reason: "unsupported" };
  }
  if (opts.signal?.aborted) return { handled: false, reason: "aborted" };

  const model = localModelForTier(opts.tier);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let engine: any;
  try {
    engine = await ensureEngine({ model, onProgress: opts.onProgress });
  } catch {
    await disposeLocalLlm();
    return { handled: false, reason: "load_failed" };
  }

  if (opts.signal?.aborted) return { handled: false, reason: "aborted" };

  const userPrompt = buildLocalPlannerUserPrompt(opts.messages, opts.context);

  let raw: string;
  try {
    const reply = await engine.chat.completions.create({
      messages: [
        { role: "system", content: LOCAL_PLANNER_SYSTEM_PROMPT },
        { role: "user", content: userPrompt }
      ],
      temperature: LOCAL_LLM.temperature,
      seed: LOCAL_LLM.seed,
      max_tokens: LOCAL_LLM.maxTokens,
      // JSON-mode: WebLLM enforces well-formed JSON output in WASM.
      response_format: { type: "json_object" }
    });
    raw = reply?.choices?.[0]?.message?.content ?? "";
  } catch {
    return { handled: false, reason: "infer_failed" };
  }

  const parsed = extractJsonObject<Record<string, unknown>>(raw);
  if (!parsed) return { handled: false, reason: "bad_json" };

  const result = coerceResult(parsed);
  if (!result) return { handled: false, reason: "bad_json" };

  return { handled: true, result, model };
}

// ---------------------------------------------------------------------
// Defensive coercion: model JSON → strict LocalPlanResult
// ---------------------------------------------------------------------

function coerceResult(o: Record<string, unknown>): LocalPlanResult | null {
  const mode = o.mode;

  if (mode === "extract") {
    const range = coerceExtract(o.extractRange);
    if (!range) return null;
    return { mode: "extract", extractRange: range, message: str(o.message, "Grabbing that exact slice.") };
  }

  if (mode === "clarify") {
    const questions = coerceQuestions(o.questions);
    return {
      mode: "clarify",
      questions:
        questions.length > 0
          ? questions
          : [
              {
                id: "topic",
                prompt: "What should the short be about?",
                suggestions: ["Best parts", "A specific moment", "Describe the video"],
                kind: "single-choice"
              }
            ],
      message: str(o.message, "I need a bit more to plan the cuts.")
    };
  }

  if (mode === "plan") {
    const scenarios = coerceScenarios(o.scenarios);
    const signals = coerceSignals(o.signals, scenarios.length > 0);
    // A "plan" with no scenarios is only valid on the visual-interest
    // path (semantic === 0). Otherwise reject so we fall through.
    if (scenarios.length === 0 && signals.semantic > 0) return null;
    return {
      mode: "plan",
      scenarios,
      signals,
      selectionStrategy: o.selectionStrategy === "best" ? "best" : "balanced",
      message: str(o.message, "Plan ready.")
    };
  }

  return null;
}

function coerceScenarios(
  raw: unknown
): Array<{ id: string; prompt: string; weight?: number }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ id: string; prompt: string; weight?: number }> = [];
  for (let i = 0; i < raw.length && out.length < 6; i++) {
    const s = raw[i] as Record<string, unknown> | null;
    if (!s || typeof s !== "object") continue;
    const prompt = typeof s.prompt === "string" ? s.prompt.trim().slice(0, 200) : "";
    if (!prompt) continue;
    const id =
      typeof s.id === "string" && s.id.trim()
        ? s.id.trim().slice(0, 24)
        : `s${out.length + 1}`;
    const weight =
      typeof s.weight === "number" && Number.isFinite(s.weight) ? s.weight : undefined;
    out.push({ id, prompt, ...(weight !== undefined ? { weight } : {}) });
  }
  return out;
}

function coerceSignals(
  raw: unknown,
  hasScenarios: boolean
): { semantic: number; motion: number; saliency: number } {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  let sem = num(o.semantic);
  let mot = num(o.motion);
  let sal = num(o.saliency);
  if (sem === null && mot === null && sal === null) {
    // No usable signals — choose a sensible default by scenario presence.
    return hasScenarios
      ? { semantic: 0.7, motion: 0.2, saliency: 0.1 }
      : { semantic: 0, motion: 0.6, saliency: 0.4 };
  }
  sem = clamp01(sem ?? 0);
  mot = clamp01(mot ?? 0);
  sal = clamp01(sal ?? 0);
  const sum = sem + mot + sal;
  if (sum <= 0) return { semantic: 0, motion: 0.6, saliency: 0.4 };
  return { semantic: sem / sum, motion: mot / sum, saliency: sal / sum };
}

function coerceExtract(
  raw: unknown
): { kind: "first" | "last" | "absolute"; startSeconds: number; endSeconds: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const kind =
    o.kind === "first" || o.kind === "last" || o.kind === "absolute"
      ? o.kind
      : "absolute";
  const start = num(o.startSeconds);
  const end = num(o.endSeconds);
  if (start === null || end === null) return null;
  if (end <= start && kind !== "last") return null;
  return { kind, startSeconds: Math.max(0, start), endSeconds: Math.max(0, end) };
}

function coerceQuestions(
  raw: unknown
): Array<{ id: string; prompt: string; suggestions: string[]; kind: "single-choice" | "free-text" }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{
    id: string;
    prompt: string;
    suggestions: string[];
    kind: "single-choice" | "free-text";
  }> = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    const obj = q as Record<string, unknown>;
    const prompt = typeof obj.prompt === "string" ? obj.prompt.trim() : "";
    if (!prompt) continue;
    const suggestions = Array.isArray(obj.suggestions)
      ? obj.suggestions.filter((s): s is string => typeof s === "string").slice(0, 4)
      : [];
    out.push({
      id: typeof obj.id === "string" && obj.id ? obj.id : `q${out.length + 1}`,
      prompt: prompt.slice(0, 200),
      suggestions,
      kind: obj.kind === "free-text" ? "free-text" : "single-choice"
    });
    if (out.length >= 3) break;
  }
  return out;
}

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const p = Number(v);
    if (Number.isFinite(p)) return p;
  }
  return null;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

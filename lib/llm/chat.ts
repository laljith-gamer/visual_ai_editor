// =====================================================================
// lib/llm/chat.ts
//
// Capable LOCAL CHAT layer — the chat.webllm.ai core, but wired for this
// editor. Built on top of the WebLLM engine singleton in engine.ts.
//
// What this adds over the constrained planner (planLocally):
//   - Free-form, multi-turn CONVERSATION (not just planner JSON).
//   - STREAMING token output (AsyncGenerator), so the UI renders live.
//   - A MODEL MANAGER: list available models, pick one, load it with
//     download/compile progress, switch models, and report what's active.
//   - Graceful, never-throws behaviour: load/inference failures surface
//     as typed results so callers fall back cleanly.
//
// This module performs NO cloud calls. WebLLM downloads model artifacts
// from the HF CDN + raw.githubusercontent.com (model_lib .wasm). Heavy
// inference runs in the worker (see webllm.worker.ts), off the main
// thread, so the editor UI stays responsive.
// =====================================================================

import { LOCAL_LLM } from "@/lib/config";
import {
  ensureLocalEngine,
  isLocalLlmSupported,
  loadedLocalModel,
  localModelForTier
} from "@/lib/llm/engine";
import type { CapabilityTier } from "@/lib/types";
import type { LocalChatMessage, LocalLlmProgress } from "@/lib/llm/types";

// ---------------------------------------------------------------------
// Model manager
// ---------------------------------------------------------------------

/** A model the user can pick, distilled from WebLLM's prebuilt list. */
export interface LocalModelInfo {
  /** WebLLM model id (pass to loadModel / chat). */
  id: string;
  /** Friendly family/name for display ("Llama 3.1 8B Instruct"). */
  label: string;
  /** Rough VRAM requirement in MB if WebLLM provides it, else undefined. */
  vramMB?: number;
  /** Quantization tag parsed from the id (e.g. "q4f16_1"). */
  quant?: string;
  /** True if this is the currently-loaded model. */
  active: boolean;
}

/**
 * List the chat-capable models WebLLM ships with, filtered to instruct/
 * chat families and sorted smallest-VRAM-first so the picker leads with
 * the most loadable options. Returns [] when the package or list is
 * unavailable (never throws).
 */
export async function listLocalModels(): Promise<LocalModelInfo[]> {
  let prebuilt: { model_id: string; vram_required_MB?: number }[];
  try {
    const webllm = await import("@mlc-ai/web-llm");
    prebuilt = (webllm.prebuiltAppConfig?.model_list ?? []) as typeof prebuilt;
  } catch {
    return [];
  }
  const active = loadedLocalModel();
  // Keep instruct/chat-style models; drop embedding/other task models.
  const CHATTY = /(instruct|chat|hermes|gemma|mistral|qwen|llama|phi|smollm)/i;
  const items = prebuilt
    .filter((m) => CHATTY.test(m.model_id))
    .map<LocalModelInfo>((m) => ({
      id: m.model_id,
      label: prettyModelLabel(m.model_id),
      vramMB:
        typeof m.vram_required_MB === "number" ? m.vram_required_MB : undefined,
      quant: parseQuant(m.model_id),
      active: m.model_id === active
    }));
  // Stable sort: by VRAM asc (unknown last), then id for determinism.
  items.sort((a, b) => {
    const av = a.vramMB ?? Number.POSITIVE_INFINITY;
    const bv = b.vramMB ?? Number.POSITIVE_INFINITY;
    if (av !== bv) return av - bv;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return items;
}

/** Default chat model for a device tier (reuses the planner tiers). */
export function defaultChatModelForTier(tier: CapabilityTier): string {
  return localModelForTier(tier);
}

export interface LoadModelOptions {
  model: string;
  onProgress?: (p: LocalLlmProgress) => void;
  /** When false, returns immediately without attempting a load. */
  enabled?: boolean;
}

export type LoadModelResult =
  | { ok: true; model: string }
  | { ok: false; reason: "disabled" | "unsupported" | "load_failed" };

/**
 * Load (download + compile) a specific model, reporting progress. Safe to
 * call repeatedly; the engine singleton reloads only when the model id
 * changes. Never throws.
 */
export async function loadModel(
  tier: CapabilityTier,
  opts: LoadModelOptions
): Promise<LoadModelResult> {
  if (!(opts.enabled ?? true)) return { ok: false, reason: "disabled" };
  if (!isLocalLlmSupported(tier)) return { ok: false, reason: "unsupported" };
  try {
    await ensureLocalEngine({ model: opts.model, onProgress: opts.onProgress });
    return { ok: true, model: opts.model };
  } catch {
    return { ok: false, reason: "load_failed" };
  }
}

// ---------------------------------------------------------------------
// Streaming chat
// ---------------------------------------------------------------------

export interface ChatTurnOptions {
  tier: CapabilityTier;
  /** Master switch. Default true here (the chat surface is explicit). */
  enabled?: boolean;
  /** Full conversation so far (system optional; we prepend a default). */
  messages: LocalChatMessage[];
  /** Explicit model id; defaults to the tier's chat model. */
  model?: string;
  /** Optional system prompt override. */
  system?: string;
  /** Optional grounding context (briefing best-parts + reasons, footage
   *  outline, timeline state) injected into the system message so the
   *  model can answer questions like "why are these the best parts"
   *  from real data instead of hallucinating. Build via
   *  lib/llm/grounding.ts → buildChatGrounding(). */
  grounding?: string;
  temperature?: number;
  maxTokens?: number;
  onProgress?: (p: LocalLlmProgress) => void;
  signal?: AbortSignal;
}

export type ChatStreamEvent =
  | { type: "loading"; progress: number; text: string }
  | { type: "delta"; text: string }
  | { type: "done"; full: string }
  | {
      type: "error";
      reason: "disabled" | "unsupported" | "load_failed" | "infer_failed" | "aborted";
    };

const DEFAULT_CHAT_SYSTEM =
  "You are the in-app assistant for a browser-based video editor. Answer the user clearly and concisely. You can discuss the video, the timeline clips, and editing ideas. Keep replies short unless asked for detail. Never claim to have changed the timeline — a separate action layer performs edits.";

/**
 * Stream a chat completion locally. Yields loading events while the model
 * downloads/compiles, then `delta` events per token, then a final `done`.
 * On any failure yields a single `error` event (never throws).
 *
 * Usage:
 *   for await (const ev of streamChat({ tier, messages })) { ... }
 */
export async function* streamChat(
  opts: ChatTurnOptions
): AsyncGenerator<ChatStreamEvent, void, unknown> {
  if (!(opts.enabled ?? true)) {
    yield { type: "error", reason: "disabled" };
    return;
  }
  if (!isLocalLlmSupported(opts.tier)) {
    yield { type: "error", reason: "unsupported" };
    return;
  }
  if (opts.signal?.aborted) {
    yield { type: "error", reason: "aborted" };
    return;
  }

  const model = opts.model ?? defaultChatModelForTier(opts.tier);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let engine: any;
  try {
    engine = await ensureLocalEngine({
      model,
      onProgress: (p) => {
        opts.onProgress?.(p);
      }
    });
  } catch {
    yield { type: "error", reason: "load_failed" };
    return;
  }

  if (opts.signal?.aborted) {
    yield { type: "error", reason: "aborted" };
    return;
  }

  const system = opts.system ?? DEFAULT_CHAT_SYSTEM;
  const groundedSystem =
    opts.grounding && opts.grounding.trim()
      ? `${system}\n\nCONTEXT (use this to answer; do not invent facts beyond it):\n${opts.grounding.trim()}`
      : system;
  const messages = [
    { role: "system", content: groundedSystem },
    ...opts.messages.filter((m) => m.role !== "system")
  ];

  let full = "";
  try {
    const chunks = await engine.chat.completions.create({
      messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? LOCAL_LLM.maxTokens,
      stream: true
    });
    for await (const chunk of chunks) {
      if (opts.signal?.aborted) {
        yield { type: "error", reason: "aborted" };
        return;
      }
      const delta: string = chunk?.choices?.[0]?.delta?.content ?? "";
      if (delta) {
        full += delta;
        yield { type: "delta", text: delta };
      }
    }
  } catch {
    yield { type: "error", reason: "infer_failed" };
    return;
  }

  yield { type: "done", full };
}

/**
 * Non-streaming convenience wrapper: returns the full reply string, or
 * null on any failure. Built on streamChat so behaviour stays identical.
 */
export async function chatOnce(opts: ChatTurnOptions): Promise<string | null> {
  let full = "";
  let errored = false;
  for await (const ev of streamChat(opts)) {
    if (ev.type === "delta") full += ev.text;
    else if (ev.type === "done") full = ev.full;
    else if (ev.type === "error") errored = true;
  }
  return errored && full.length === 0 ? null : full;
}

// ---------------------------------------------------------------------
// Label helpers (pure)
// ---------------------------------------------------------------------

function parseQuant(modelId: string): string | undefined {
  const m = modelId.match(/q\d+f\d+(?:_\d+)?/i);
  return m ? m[0] : undefined;
}

/** Turn "Llama-3.1-8B-Instruct-q4f16_1-MLC" into "Llama 3.1 8B Instruct". */
function prettyModelLabel(modelId: string): string {
  let s = modelId;
  // Drop trailing packaging suffixes.
  s = s.replace(/-MLC(?:-\d+k)?$/i, "");
  s = s.replace(/-q\d+f\d+(?:_\d+)?$/i, "");
  // Hyphens → spaces, collapse repeats.
  s = s.replace(/[-_]+/g, " ").trim();
  return s;
}

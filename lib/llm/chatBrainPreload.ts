// =====================================================================
// lib/llm/chatBrainPreload.ts
//
// Client-side "Chat Brain" warmup + text-only resolver client. Warms the
// cloud text provider in the BACKGROUND (after the editor is ready / first
// upload) so the first ambiguous chat turn is fast, then exposes a
// privacy-safe `resolveWithChatBrain` used ONLY as a low-confidence fallback.
//
// - Idempotent: one warmup job regardless of how many callers ask.
// - Non-blocking: never awaited on the UI thread; status is observable.
// - Privacy-safe: only compact text state leaves the browser (payload built
//   by buildChatBrainPayload; the server also rejects media-shaped keys).
// - Degrades silently: no provider → status "unavailable", deterministic
//   resolver keeps working, no error shown.
//
// The PURE decision helpers (shouldPreload / nextStatus) are exported for
// unit tests; the fetch-based functions guard SSR + never throw into the UI.
// =====================================================================

import { CHAT_BRAIN } from "../config";
import {
  buildChatBrainPayload,
  parseChatBrainIntent,
  type ChatBrainIntent,
  type ChatBrainPayloadInput
} from "./chatBrainSchema";

export type ChatBrainStatus = "idle" | "warming" | "ready" | "unavailable" | "failed";

const INTENT_ENDPOINT = "/api/agent/intent";

let status: ChatBrainStatus = "idle";
let warmupPromise: Promise<ChatBrainStatus> | null = null;
const listeners = new Set<(s: ChatBrainStatus) => void>();

function setStatus(next: ChatBrainStatus): void {
  if (status === next) return;
  status = next;
  for (const cb of listeners) {
    try {
      cb(next);
    } catch {
      /* listener errors never break the brain */
    }
  }
}

export function getChatBrainStatus(): ChatBrainStatus {
  return status;
}

export function subscribeChatBrain(cb: (s: ChatBrainStatus) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function chatBrainReady(): boolean {
  return status === "ready";
}

/** Coarse device signals (all optional / privacy-preserving, never sent). */
export interface PreloadEnv {
  saveData: boolean;
  deviceMemoryGb?: number;
}

export function readPreloadEnv(): PreloadEnv {
  if (typeof navigator === "undefined") return { saveData: false };
  const conn = (navigator as unknown as { connection?: { saveData?: boolean } }).connection;
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
  return {
    saveData: Boolean(conn?.saveData),
    deviceMemoryGb: typeof mem === "number" ? mem : undefined
  };
}

/** PURE: decide whether to run the background warmup. Tested. */
export function shouldPreload(env: PreloadEnv): { preload: boolean; allowLocal: boolean; reason: string } {
  if (!CHAT_BRAIN.preloadEnabled) return { preload: false, allowLocal: false, reason: "disabled" };
  if (CHAT_BRAIN.skipWhenSaveData && env.saveData) {
    return { preload: false, allowLocal: false, reason: "save-data" };
  }
  // Cloud warmup is cheap → allowed even on low memory. Local model warmup is
  // gated by device memory (and is off by default anyway).
  const allowLocal =
    CHAT_BRAIN.localWarmupEnabled &&
    (env.deviceMemoryGb === undefined || env.deviceMemoryGb >= CHAT_BRAIN.minDeviceMemoryGb);
  return { preload: CHAT_BRAIN.cloudWarmupEnabled || allowLocal, allowLocal, reason: "ok" };
}

async function fetchWithTimeout(body: unknown, timeoutMs: number): Promise<Response | null> {
  if (typeof fetch === "undefined") return null;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    return await fetch(INTENT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller?.signal
    });
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Start the background warmup. Idempotent + safe to call repeatedly: the
 * first call creates the single warmup job; later calls return the same
 * in-flight promise (or a resolved one if already settled).
 */
export function preloadChatBrain(): Promise<ChatBrainStatus> {
  if (warmupPromise) return warmupPromise;
  if (status === "ready" || status === "unavailable") {
    return Promise.resolve(status);
  }

  const env = readPreloadEnv();
  const decision = shouldPreload(env);
  if (!decision.preload) {
    setStatus("unavailable");
    warmupPromise = Promise.resolve<ChatBrainStatus>("unavailable");
    return warmupPromise;
  }

  setStatus("warming");
  warmupPromise = (async () => {
    const res = await fetchWithTimeout({ task: "warmup", schema: "intent-router-v1" }, CHAT_BRAIN.maxWarmupMs);
    if (!res || !res.ok) {
      setStatus("unavailable");
      return "unavailable";
    }
    try {
      const data = (await res.json()) as { status?: string };
      setStatus(data.status === "ready" ? "ready" : "unavailable");
    } catch {
      setStatus("unavailable");
    }
    return status;
  })();
  return warmupPromise;
}

/**
 * Resolve an ambiguous turn / free-text answer with the warmed text brain.
 * Returns null when the brain is unavailable, the request fails/times out, or
 * the response isn't a valid ChatBrainIntent — the caller then falls back to
 * deterministic logic. NEVER throws into the UI. NEVER sends media.
 */
export async function resolveWithChatBrain(
  input: ChatBrainPayloadInput
): Promise<ChatBrainIntent | null> {
  // If we already know there's no provider, don't bother the network.
  if (status === "unavailable") return null;

  const payload = buildChatBrainPayload(input);
  const res = await fetchWithTimeout(payload, CHAT_BRAIN.resolveTimeoutMs);
  if (!res || !res.ok) return null;
  try {
    const data = (await res.json()) as { intent?: unknown; unavailable?: boolean };
    if (data.unavailable) {
      setStatus("unavailable");
      return null;
    }
    // A successful resolve proves the provider is reachable.
    if (status !== "ready") setStatus("ready");
    return parseChatBrainIntent(data.intent);
  } catch {
    return null;
  }
}

/** Test-only: reset the module singletons. */
export function __resetChatBrainForTest(): void {
  status = "idle";
  warmupPromise = null;
  listeners.clear();
}

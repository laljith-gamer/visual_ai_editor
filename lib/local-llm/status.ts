// =====================================================================
// lib/local-llm/status.ts
//
// Tiny dependency-free pub/sub store for the AI-mode status indicator
// (Cloud / Local / Manual) and the WebLLM loading progress. Kept
// SEPARATE from the WebLLM engine module so the UI badge can import and
// subscribe to it WITHOUT pulling @mlc-ai/web-llm into the initial
// bundle. This module imports nothing heavy.
//
// The editor store (zustand) is intentionally untouched — this is a
// self-contained external store consumed via useSyncExternalStore.
// =====================================================================

import { useSyncExternalStore } from "react";

/** Which planner path produced (or is producing) the current answer. */
export type AIMode = "cloud" | "local" | "manual";

/** Lifecycle of the local WebLLM engine. */
export type LocalPhase = "idle" | "loading" | "ready" | "error";

export interface LocalAIStatus {
  /** Current AI path. Defaults to "local" (the on-device brain). */
  mode: AIMode;
  /** Local engine lifecycle. */
  phase: LocalPhase;
  /** Model download/compile progress in [0, 1] while phase === "loading". */
  progress: number;
  /** Human-readable status line (e.g. "Local AI loading…"). */
  text?: string;
}

let state: LocalAIStatus = { mode: "local", phase: "idle", progress: 0 };
const listeners = new Set<() => void>();

export function getLocalAIStatus(): LocalAIStatus {
  return state;
}

/** Merge a partial update and notify subscribers. */
export function setLocalAIStatus(patch: Partial<LocalAIStatus>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

/** Reset back to the default on-device state. */
export function resetLocalAIStatus(): void {
  setLocalAIStatus({ mode: "local", phase: "idle", progress: 0, text: undefined });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** React hook for components that want to render the current AI mode. */
export function useLocalAIStatus(): LocalAIStatus {
  return useSyncExternalStore(subscribe, getLocalAIStatus, getLocalAIStatus);
}

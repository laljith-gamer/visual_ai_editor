"use client";

// =====================================================================
// lib/ai/brainPreference.ts
//
// Tiny, dependency-free preference store for WHICH AI brain plans a turn:
//   - "local" → the on-device WebLLM model (+ deterministic safety net)
//   - "cloud" → "Kiro" (a configured cloud model, e.g. Claude Opus)
//
// It is a self-contained external store (same pattern as
// lib/local-llm/status.ts) so the chat toggle and the planner read ONE
// source of truth without touching the big editor store. The choice is
// persisted to localStorage so it survives reloads and new sessions.
//
// The toggle only EXPOSES "cloud" when the server reports a cloud provider
// is configured (see /api/agent/intent warmup); this module just records the
// user's choice.
// =====================================================================

import { useSyncExternalStore } from "react";

export type AIBrain = "local" | "cloud";

const STORAGE_KEY = "vae.aiBrain";

function readInitial(): AIBrain {
  if (typeof localStorage === "undefined") return "local";
  try {
    return localStorage.getItem(STORAGE_KEY) === "cloud" ? "cloud" : "local";
  } catch {
    return "local";
  }
}

let brain: AIBrain = readInitial();
const listeners = new Set<() => void>();

export function getAIBrain(): AIBrain {
  return brain;
}

export function setAIBrain(next: AIBrain): void {
  if (brain === next) return;
  brain = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* private mode / storage disabled — in-memory choice still works */
  }
  for (const cb of listeners) cb();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** React hook returning the current brain choice. SSR-safe (defaults local). */
export function useAIBrain(): AIBrain {
  return useSyncExternalStore(subscribe, getAIBrain, () => "local" as AIBrain);
}

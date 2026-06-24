"use client";

// =====================================================================
// lib/ai/cloudAnalysisPreference.ts
//
// Single source of truth for the "cloud analysis" toggle that decides HOW
// the heavy media-understanding passes run:
//
//   - FALSE (default) → FULLY OFFLINE / on-device, exactly as before:
//       * scene analysis  : in-browser SigLIP (+ optional captioning)
//       * transcription   : in-browser Whisper (WebGPU/WASM)
//     Nothing leaves the device.
//
//   - TRUE → route scene analysis AND transcription to a FREE OpenRouter
//     analysis model for speed. The offline path always remains the
//     guaranteed fallback (OFFLINE EDIT principle): if OpenRouter isn't
//     configured/reachable, or the input is too large, the code silently
//     falls back to the on-device path and the AI says so.
//
// DEFAULT comes from the env flag NEXT_PUBLIC_CLOUD_ANALYSIS (build-time,
// client-readable). A localStorage override (set by the UI toggle) wins at
// runtime so users can flip it without a redeploy. Same self-contained
// external-store pattern as lib/ai/brainPreference.ts.
//
// IMPORTANT: this only changes WHERE scene/transcribe analysis runs. It does
// NOT hardcode any commands or intent — the planner/brain choice is separate
// (see brainPreference.ts).
// =====================================================================

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "vae.cloudAnalysis";

/** Build-time default from the public env flag. Accepts true/1/on. */
function envDefault(): boolean {
  const v = process.env.NEXT_PUBLIC_CLOUD_ANALYSIS;
  if (!v) return false;
  const n = v.trim().toLowerCase();
  return n === "true" || n === "1" || n === "on";
}

/** Resolve the initial value: localStorage override (if the user set one)
 *  else the env default. SSR-safe. */
function readInitial(): boolean {
  const fallback = envDefault();
  if (typeof localStorage === "undefined") return fallback;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "true") return true;
    if (stored === "false") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

let enabled = readInitial();
const listeners = new Set<() => void>();

/** Synchronous read — safe to call from non-React modules (the scene-scoring
 *  branch in executePerSource and the transcription entry both call this). */
export function cloudAnalysisEnabled(): boolean {
  return enabled;
}

/** Flip the toggle. Persists the explicit choice so it survives reloads and
 *  overrides the env default until cleared. */
export function setCloudAnalysis(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? "true" : "false");
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

/** React hook returning the current toggle state. SSR-safe (defaults to the
 *  env value so server + first client render agree). */
export function useCloudAnalysis(): boolean {
  return useSyncExternalStore(subscribe, cloudAnalysisEnabled, envDefault);
}

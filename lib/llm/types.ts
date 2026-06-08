// =====================================================================
// lib/llm/types.ts
//
// Types for the LOCAL (in-browser, WebGPU) language layer.
//
// The local planner's job is the SAME as the cloud planner's: turn a
// user message (+ light context) into the structured planner JSON the
// app already understands. We deliberately target a CONSTRAINED subset
// of the cloud planner's modes — the ones a small local model can do
// reliably with JSON-mode — and let everything else fall through to the
// next layer in the chain (cloud, if configured).
//
// PURE TYPES only.
// =====================================================================

import type { CapabilityTier } from "@/lib/types";

/** Device tiers WebLLM can target. Mirrors useCapability tiers. */
export type LocalLlmTier = CapabilityTier;

/** Load/progress callback payload from WebLLM's initProgressCallback. */
export interface LocalLlmProgress {
  /** 0..1 download/compile progress. */
  progress: number;
  /** Human-readable status text from WebLLM. */
  text: string;
}

/** Why the local layer declined / failed, for logging + chain control. */
export type LocalLlmSkipReason =
  | "unsupported" // no WebGPU / no Worker
  | "disabled" // master switch off
  | "load_failed" // model download/compile failed
  | "infer_failed" // generation threw
  | "bad_json" // output couldn't be parsed even after salvage
  | "aborted";

/** A single chat turn passed to the local planner. */
export interface LocalChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Light, JSON-serializable context for the planner prompt. NEVER
 *  includes blobs or pixel data — only metadata + the tree outline. */
export interface LocalPlannerContext {
  /** Active video metadata (duration drives grounding). */
  videoMeta?: { duration: number; width?: number; height?: number };
  /** Token-lean frame-tree outline (from frameTreeToOutline). */
  treeOutline?: string;
  /** Whether a timeline already has clips (affects op append/replace). */
  highlightsCount?: number;
}

/**
 * The constrained planner result the local model emits. This is a strict
 * subset shaped to be a drop-in for the cloud planner's parsed JSON, so
 * the existing normalize/dispatch code can consume it unchanged.
 *
 * Supported local modes (small-model-reliable):
 *   - "plan"    : scenarios + signals for a highlight reel
 *   - "extract" : verbatim time-slice
 *   - "clarify" : one focused question
 * Anything else → the orchestrator returns { handled: false } and the
 * caller falls through to the next layer.
 */
export interface LocalPlanResult {
  mode: "plan" | "extract" | "clarify";
  /** plan mode */
  scenarios?: Array<{ id: string; prompt: string; weight?: number }>;
  signals?: { semantic: number; motion: number; saliency: number };
  selectionStrategy?: "balanced" | "best";
  /** extract mode */
  extractRange?: {
    kind: "first" | "last" | "absolute";
    startSeconds: number;
    endSeconds: number;
  };
  /** clarify mode */
  questions?: Array<{
    id: string;
    prompt: string;
    suggestions: string[];
    kind: "single-choice" | "free-text";
  }>;
  /** Always present: a short assistant message. */
  message: string;
}

/** Outcome of a local planning attempt. */
export type LocalPlanOutcome =
  | { handled: true; result: LocalPlanResult; model: string }
  | { handled: false; reason: LocalLlmSkipReason };

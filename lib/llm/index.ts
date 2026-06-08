// =====================================================================
// lib/llm/index.ts
//
// Public surface for the LOCAL (in-browser, WebGPU) language layer.
//
// Local-first chain (the local LLM is one link, not the whole thing):
//
//   grammar shortcut (lib/intent)
//     → VISION-EDIT-CORE deterministic engine (lib/vision-core)
//       → planLocally(...)  ← THIS module (offline WebLLM)
//         → cloud /api/agent (Gemini → Groq)  [only if configured]
//
// Typical usage:
//
//   import { planLocally, isLocalLlmSupported } from "@/lib/llm";
//   const outcome = await planLocally({ tier, enabled, messages, context });
//   if (outcome.handled) {
//     // outcome.result is a drop-in for the cloud planner's parsed JSON
//   } else {
//     // fall through to the next layer (cloud)
//   }
//
// Side-effect-free at import time; the heavy @mlc-ai/web-llm package is
// only loaded lazily inside the engine when the local path actually runs.
// =====================================================================

export {
  planLocally,
  warmLocalLlm,
  disposeLocalLlm,
  isLocalLlmSupported,
  localModelForTier,
  type LocalPlanOptions,
  type WarmOptions
} from "@/lib/llm/engine";

export {
  LOCAL_PLANNER_SYSTEM_PROMPT,
  buildLocalPlannerUserPrompt
} from "@/lib/llm/prompt";

export type {
  LocalLlmTier,
  LocalLlmProgress,
  LocalLlmSkipReason,
  LocalChatMessage,
  LocalPlannerContext,
  LocalPlanResult,
  LocalPlanOutcome
} from "@/lib/llm/types";

// =====================================================================
// lib/local-llm/config.ts
//
// Client-side feature flags + defaults for the OPTIONAL in-browser
// WebLLM local-LLM fallback (re-introduced in a scoped, opt-in form).
//
// IMPORTANT CONTEXT:
//   - The PRIMARY language/tool path is ALWAYS the cloud planner
//     (/api/agent → OpenRouter → Gemini → Groq). WebLLM is ONLY an
//     optional, local, on-device fallback for TEXT planning when the
//     cloud is unavailable. It is OFF by default.
//   - WebLLM does TEXT planner / edit-command JSON ONLY. It has NO
//     vision — it cannot describe video frames. The UI must stay
//     truthful about this.
//   - Every flag here is NEXT_PUBLIC (inlined into the client bundle at
//     build time). NONE of these is a secret — there are no API keys.
//     User video is NEVER uploaded anywhere by this path; WebLLM runs
//     fully on-device.
//
// These are read with the same `process.env.NEXT_PUBLIC_*` pattern used
// by hooks/useCapability.ts (NEXT_PUBLIC_VISION_TIER etc.).
// =====================================================================

export const LOCAL_LLM = {
  /** Master switch. When false, the local fallback is NEVER attempted and
   *  WebLLM is NEVER loaded (no chunk fetch, no model download). */
  enabled: process.env.NEXT_PUBLIC_LOCAL_LLM_ENABLED === "true",

  /** When true, the local planner is tried AUTOMATICALLY if the cloud
   *  planner fails (and WebGPU is available). When false, local AI is
   *  effectively inert even if `enabled` — kept as a separate knob so a
   *  deployment can ship the code but gate the auto-behaviour. */
  autoFallback: process.env.NEXT_PUBLIC_LOCAL_LLM_AUTO_FALLBACK === "true",

  /** Small instruct model id from WebLLM's prebuilt model list. Override
   *  with NEXT_PUBLIC_LOCAL_LLM_DEFAULT_MODEL. Defaults to a ~1B model so
   *  the one-time download/compile stays as light as possible. */
  defaultModel:
    process.env.NEXT_PUBLIC_LOCAL_LLM_DEFAULT_MODEL ||
    "Llama-3.2-1B-Instruct-q4f32_1-MLC"
} as const;

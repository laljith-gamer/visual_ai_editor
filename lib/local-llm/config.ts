// =====================================================================
// lib/local-llm/config.ts
// Client-side WebLLM local planner flags. Local planner is enabled by default
// for the current local-only build. It is text-only and has no API key.
// =====================================================================

function flagDefaultTrue(value: string | undefined): boolean {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return normalized !== "false" && normalized !== "0" && normalized !== "off";
}

export const LOCAL_LLM = {
  enabled: flagDefaultTrue(process.env.NEXT_PUBLIC_LOCAL_LLM_ENABLED),
  autoFallback: flagDefaultTrue(process.env.NEXT_PUBLIC_LOCAL_LLM_AUTO_FALLBACK),
  localOnly: flagDefaultTrue(process.env.NEXT_PUBLIC_LOCAL_AI_ONLY),
  defaultModel:
    process.env.NEXT_PUBLIC_LOCAL_LLM_DEFAULT_MODEL ||
    "Llama-3.2-1B-Instruct-q4f32_1-MLC"
} as const;

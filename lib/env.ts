// Server-only environment access. Do NOT import this from client components.

function readOptional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

export const serverEnv = {
  GEMINI_API_KEY: readOptional("GEMINI_API_KEY"),
  GEMINI_MODEL: readOptional("GEMINI_MODEL") ?? "gemini-2.5-flash",
  GROQ_API_KEY: readOptional("GROQ_API_KEY"),
  GROQ_MODEL: readOptional("GROQ_MODEL") ?? "llama-3.3-70b-versatile",
  // --- OpenRouter (SERVER-ONLY). The key must never be exposed to the
  // browser; there is intentionally NO NEXT_PUBLIC_OPENROUTER_API_KEY.
  // Model ids are optional overrides for the defaults in OPENROUTER (config).
  OPENROUTER_API_KEY: readOptional("OPENROUTER_API_KEY"),
  OPENROUTER_DEFAULT_MODEL: readOptional("OPENROUTER_DEFAULT_MODEL"),
  OPENROUTER_CHEAP_MODEL: readOptional("OPENROUTER_CHEAP_MODEL"),
  OPENROUTER_PREMIUM_MODEL: readOptional("OPENROUTER_PREMIUM_MODEL"),
  OPENROUTER_OSS_MODEL: readOptional("OPENROUTER_OSS_MODEL"),
  // Optional cap on completion tokens reserved per OpenRouter call. When
  // unset, OpenRouter pre-reserves the model's FULL output window, which can
  // 402 low-credit accounts. Defaults to OPENROUTER.maxTokens in lib/config.ts.
  OPENROUTER_MAX_TOKENS: readOptional("OPENROUTER_MAX_TOKENS"),
  // --- Custom OpenAI-compatible provider (SERVER-ONLY). Use this for
  // gateways that expose /chat/completions but are not OpenRouter. Never use
  // NEXT_PUBLIC_CUSTOM_OPENAI_API_KEY.
  CUSTOM_OPENAI_API_KEY: readOptional("CUSTOM_OPENAI_API_KEY"),
  CUSTOM_OPENAI_BASE_URL: readOptional("CUSTOM_OPENAI_BASE_URL"),
  CUSTOM_OPENAI_DEFAULT_MODEL: readOptional("CUSTOM_OPENAI_DEFAULT_MODEL"),
  CUSTOM_OPENAI_ENABLE_VISION: readOptional("CUSTOM_OPENAI_ENABLE_VISION"),
  CUSTOM_OPENAI_JSON_MODE: readOptional("CUSTOM_OPENAI_JSON_MODE"),
  // Optional public app URL sent to OpenRouter as the HTTP-Referer header.
  // Accepts a server-only APP_URL or the existing NEXT_PUBLIC_APP_URL.
  APP_URL: readOptional("APP_URL") ?? readOptional("NEXT_PUBLIC_APP_URL"),
  // Optional SERVER-ONLY toggle for which cloud provider(s) the dispatcher
  // uses and in what order. Comma-separated provider names
  // (openrouter | custom_openai | gemini | groq). Set a single name to force
  // just that provider, e.g. CLOUD_PROVIDER_ORDER=gemini. Unset → the default
  // order in lib/config.ts (openrouter,gemini,groq). See lib/providers/cloud.ts.
  CLOUD_PROVIDER_ORDER: readOptional("CLOUD_PROVIDER_ORDER"),
  SESSION_SECRET: readOptional("SESSION_SECRET"),
  UPSTASH_REDIS_REST_URL: readOptional("UPSTASH_REDIS_REST_URL"),
  UPSTASH_REDIS_REST_TOKEN: readOptional("UPSTASH_REDIS_REST_TOKEN"),
  ADMIN_TOKEN: readOptional("ADMIN_TOKEN")
};

export function hasAnyChatProvider(): boolean {
  return Boolean(
    serverEnv.OPENROUTER_API_KEY ||
      serverEnv.CUSTOM_OPENAI_API_KEY ||
      serverEnv.GEMINI_API_KEY ||
      serverEnv.GROQ_API_KEY
  );
}

/** True when an OpenRouter API key is configured (server-side only). */
export function hasOpenRouter(): boolean {
  return Boolean(serverEnv.OPENROUTER_API_KEY);
}

/** True when a custom OpenAI-compatible provider is configured. */
export function hasCustomOpenAI(): boolean {
  return Boolean(
    serverEnv.CUSTOM_OPENAI_API_KEY && serverEnv.CUSTOM_OPENAI_BASE_URL
  );
}

export function hasGemini(): boolean {
  return Boolean(serverEnv.GEMINI_API_KEY);
}

/** True when a vision-capable cloud provider is configured. OpenRouter
 *  qualifies because its configured/default model may be multimodal; direct
 *  Gemini also qualifies. Custom OpenAI-compatible providers qualify only when
 *  CUSTOM_OPENAI_ENABLE_VISION=true. Groq is text-only and does not count. */
export function hasAnyVisionProvider(): boolean {
  return Boolean(
    serverEnv.OPENROUTER_API_KEY ||
      (hasCustomOpenAI() &&
        (serverEnv.CUSTOM_OPENAI_ENABLE_VISION === "1" ||
          serverEnv.CUSTOM_OPENAI_ENABLE_VISION?.toLowerCase() === "true")) ||
      serverEnv.GEMINI_API_KEY
  );
}

export function hasRateLimit(): boolean {
  return Boolean(
    serverEnv.UPSTASH_REDIS_REST_URL && serverEnv.UPSTASH_REDIS_REST_TOKEN
  );
}

export function hasAdminAccess(): boolean {
  return Boolean(serverEnv.ADMIN_TOKEN);
}

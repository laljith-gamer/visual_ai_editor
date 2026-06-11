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
  // Optional public app URL sent to OpenRouter as the HTTP-Referer header.
  // Accepts a server-only APP_URL or the existing NEXT_PUBLIC_APP_URL.
  APP_URL: readOptional("APP_URL") ?? readOptional("NEXT_PUBLIC_APP_URL"),
  SESSION_SECRET: readOptional("SESSION_SECRET"),
  UPSTASH_REDIS_REST_URL: readOptional("UPSTASH_REDIS_REST_URL"),
  UPSTASH_REDIS_REST_TOKEN: readOptional("UPSTASH_REDIS_REST_TOKEN"),
  ADMIN_TOKEN: readOptional("ADMIN_TOKEN")
};

export function hasAnyChatProvider(): boolean {
  return Boolean(
    serverEnv.OPENROUTER_API_KEY ||
      serverEnv.GEMINI_API_KEY ||
      serverEnv.GROQ_API_KEY
  );
}

/** True when an OpenRouter API key is configured (server-side only). */
export function hasOpenRouter(): boolean {
  return Boolean(serverEnv.OPENROUTER_API_KEY);
}

export function hasGemini(): boolean {
  return Boolean(serverEnv.GEMINI_API_KEY);
}

/** True when a vision-capable cloud provider is configured. OpenRouter
 *  qualifies because its default model (google/gemini-2.5-flash) is
 *  multimodal; direct Gemini also qualifies. Groq is text-only and does
 *  not count here. */
export function hasAnyVisionProvider(): boolean {
  return Boolean(serverEnv.OPENROUTER_API_KEY || serverEnv.GEMINI_API_KEY);
}

export function hasRateLimit(): boolean {
  return Boolean(
    serverEnv.UPSTASH_REDIS_REST_URL && serverEnv.UPSTASH_REDIS_REST_TOKEN
  );
}

export function hasAdminAccess(): boolean {
  return Boolean(serverEnv.ADMIN_TOKEN);
}

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
  SESSION_SECRET: readOptional("SESSION_SECRET"),
  UPSTASH_REDIS_REST_URL: readOptional("UPSTASH_REDIS_REST_URL"),
  UPSTASH_REDIS_REST_TOKEN: readOptional("UPSTASH_REDIS_REST_TOKEN"),
  ADMIN_TOKEN: readOptional("ADMIN_TOKEN")
};

export function hasAnyChatProvider(): boolean {
  return Boolean(serverEnv.GEMINI_API_KEY || serverEnv.GROQ_API_KEY);
}

export function hasGemini(): boolean {
  return Boolean(serverEnv.GEMINI_API_KEY);
}

export function hasRateLimit(): boolean {
  return Boolean(
    serverEnv.UPSTASH_REDIS_REST_URL && serverEnv.UPSTASH_REDIS_REST_TOKEN
  );
}

export function hasAdminAccess(): boolean {
  return Boolean(serverEnv.ADMIN_TOKEN);
}

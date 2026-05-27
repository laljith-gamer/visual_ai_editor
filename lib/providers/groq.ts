import Groq from "groq-sdk";
import { serverEnv } from "@/lib/env";

let cached: Groq | null = null;

function getClient(): Groq {
  if (!serverEnv.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not set");
  }
  if (cached) return cached;
  cached = new Groq({ apiKey: serverEnv.GROQ_API_KEY });
  return cached;
}

/** Call Groq with system+user, request JSON object back. */
export async function groqJson(
  system: string,
  user: string,
  options: { temperature?: number } = {}
): Promise<string> {
  const client = getClient();
  const completion = await client.chat.completions.create({
    model: serverEnv.GROQ_MODEL,
    response_format: { type: "json_object" },
    temperature: options.temperature ?? 0.4,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });
  return completion.choices[0]?.message?.content ?? "{}";
}

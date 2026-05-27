import { GoogleGenerativeAI, type GenerativeModel } from "@google/generative-ai";
import { serverEnv } from "@/lib/env";

let cached: GenerativeModel | null = null;

function getModel(): GenerativeModel {
  if (!serverEnv.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  if (cached) return cached;
  const client = new GoogleGenerativeAI(serverEnv.GEMINI_API_KEY);
  cached = client.getGenerativeModel({
    model: serverEnv.GEMINI_MODEL,
    generationConfig: {
      temperature: 0.4,
      responseMimeType: "application/json"
    }
  });
  return cached;
}

/** Call Gemini with a system prompt + user prompt and expect JSON back. */
export async function geminiJson(
  system: string,
  user: string,
  options: { temperature?: number } = {}
): Promise<string> {
  const model = getModel();
  const result = await model.generateContent({
    contents: [
      { role: "user", parts: [{ text: `${system}\n\n${user}` }] }
    ],
    generationConfig: {
      temperature: options.temperature ?? 0.4,
      responseMimeType: "application/json"
    }
  });
  return result.response.text();
}

/** Call Gemini with an inline image (base64) plus a prompt. Returns JSON text. */
export async function geminiVisionJson(
  prompt: string,
  imageBase64: string,
  mimeType = "image/jpeg",
  options: { temperature?: number } = {}
): Promise<string> {
  const model = getModel();
  const result = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { mimeType, data: imageBase64 } }
        ]
      }
    ],
    generationConfig: {
      temperature: options.temperature ?? 0.2,
      responseMimeType: "application/json"
    }
  });
  return result.response.text();
}

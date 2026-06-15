// =====================================================================
// lib/providers/customOpenai.ts
//
// SERVER-SIDE custom OpenAI-compatible chat-completions client.
//
// This is for providers that expose a /chat/completions endpoint but are NOT
// OpenRouter. Example: a custom gateway/base URL supplied through env.
//
// SECURITY:
//   - CUSTOM_OPENAI_API_KEY is server-only via lib/env.ts.
//   - There is intentionally no NEXT_PUBLIC_CUSTOM_OPENAI_API_KEY.
//   - This module must not be imported by client components.
//   - Never log prompts, keys, base64 frame data, transcript text, or video.
// =====================================================================

import { serverEnv } from "@/lib/env";
import { recordAiUsage, type AiUsageKind } from "@/lib/ai/usage";

function apiKey(): string {
  const key = serverEnv.CUSTOM_OPENAI_API_KEY;
  if (!key) throw new Error("CUSTOM_OPENAI_API_KEY is not set");
  return key;
}

function baseUrl(): string {
  const raw = serverEnv.CUSTOM_OPENAI_BASE_URL;
  if (!raw) throw new Error("CUSTOM_OPENAI_BASE_URL is not set");
  return raw.replace(/\/+$/, "");
}

function model(): string {
  return serverEnv.CUSTOM_OPENAI_DEFAULT_MODEL ?? "gpt-5.5-pro";
}

export function customOpenaiVisionEnabled(): boolean {
  const raw = serverEnv.CUSTOM_OPENAI_ENABLE_VISION;
  return raw === "1" || raw?.toLowerCase() === "true";
}

type TextPart = { type: "text"; text: string };
type ImagePart = { type: "image_url"; image_url: { url: string } };
type Content = string | Array<TextPart | ImagePart>;

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: Content;
}

interface OpenAiUsageEnvelope {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

interface CustomOpenAIEnvelope {
  model?: string;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: OpenAiUsageEnvelope;
}

export interface CustomOpenAIOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

async function createCompletion(
  messages: ChatMessage[],
  opts: CustomOpenAIOptions = {}
): Promise<string> {
  const requestedModel = model();
  const body: Record<string, unknown> = {
    model: requestedModel,
    messages,
    temperature: opts.temperature ?? 0.25
  };
  if (typeof opts.maxTokens === "number") body.max_tokens = opts.maxTokens;
  if (serverEnv.CUSTOM_OPENAI_JSON_MODE === "1" || serverEnv.CUSTOM_OPENAI_JSON_MODE?.toLowerCase() === "true") {
    body.response_format = { type: "json_object" };
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: opts.signal
    });
  } catch (err) {
    throw new Error(
      `Custom OpenAI request failed (network): ${(err as Error)?.message ?? "fetch failed"}`
    );
  }

  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      if (typeof j?.error?.message === "string") {
        detail = `: ${j.error.message.slice(0, 200)}`;
      }
    } catch {
      // ignore unparseable error bodies
    }
    throw new Error(
      `Custom OpenAI request failed [${res.status} ${res.statusText}]${detail}`
    );
  }

  let data: CustomOpenAIEnvelope;
  try {
    data = (await res.json()) as CustomOpenAIEnvelope;
  } catch (err) {
    throw new Error(
      `Custom OpenAI returned unparseable JSON envelope: ${(err as Error)?.message ?? "parse error"}`
    );
  }
  const content = data?.choices?.[0]?.message?.content;
  recordAiUsage({
    provider: "custom_openai",
    kind: completionKind(messages),
    model: typeof data.model === "string" && data.model ? data.model : requestedModel,
    apiKeyName: "CUSTOM_OPENAI_API_KEY",
    tokens: {
      input: data.usage?.prompt_tokens ?? data.usage?.input_tokens,
      output: data.usage?.completion_tokens ?? data.usage?.output_tokens,
      total: data.usage?.total_tokens
    }
  });
  return typeof content === "string" ? content : "";
}

function completionKind(messages: ChatMessage[]): AiUsageKind {
  for (const message of messages) {
    if (
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "image_url")
    ) {
      return "vision";
    }
  }
  return "planner";
}

export async function customOpenaiJson(
  system: string,
  user: string,
  options: CustomOpenAIOptions = {}
): Promise<string> {
  return createCompletion(
    [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    options
  );
}

export async function customOpenaiMultiImageJson(
  prompt: string,
  images: Array<{ base64: string; mimeType?: string }>,
  options: CustomOpenAIOptions = {}
): Promise<string> {
  if (!customOpenaiVisionEnabled()) {
    throw new Error("CUSTOM_OPENAI_ENABLE_VISION is not enabled");
  }
  if (images.length === 0) {
    throw new Error("customOpenaiMultiImageJson called with zero images");
  }
  const content: Array<TextPart | ImagePart> = [
    { type: "text", text: prompt },
    ...images.map<ImagePart>((img) => ({
      type: "image_url",
      image_url: {
        url: `data:${img.mimeType ?? "image/jpeg"};base64,${img.base64}`
      }
    }))
  ];
  return createCompletion([{ role: "user", content }], options);
}

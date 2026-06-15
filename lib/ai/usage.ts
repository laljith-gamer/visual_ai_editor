// =====================================================================
// lib/ai/usage.ts
//
// SERVER-SIDE AI usage telemetry.
//
// Tracks successful AI API calls made by this running server instance so the
// editor can show an honest, lightweight usage meter. This module NEVER stores
// or returns secret values. It records only the provider, model, call type,
// token counts reported by the provider, and the server-only env var name used
// for the API key (for example OPENROUTER_API_KEY).
// =====================================================================

export type AiUsageProvider = "openrouter" | "custom_openai" | "gemini" | "groq";
export type AiUsageKind = "planner" | "vision";

export interface AiTokenUsage {
  input?: number;
  output?: number;
  total?: number;
}

export interface AiUsageRecord {
  provider: AiUsageProvider;
  kind: AiUsageKind;
  model: string;
  apiKeyName: string;
  tokens?: AiTokenUsage;
  at?: number;
}

interface AiUsageBucket {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AiUsageSnapshot {
  totalCalls: number;
  plannerCalls: number;
  visionCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  byProvider: Record<string, AiUsageBucket>;
  last: {
    provider: AiUsageProvider;
    kind: AiUsageKind;
    model: string;
    apiKeyName: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    at: number;
  } | null;
}

interface AiUsageState extends AiUsageSnapshot {}

const GLOBAL_KEY = "__shortsStudioAiUsage";

declare global {
  // eslint-disable-next-line no-var
  var __shortsStudioAiUsage: AiUsageState | undefined;
}

function initialState(): AiUsageState {
  return {
    totalCalls: 0,
    plannerCalls: 0,
    visionCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    byProvider: {},
    last: null
  };
}

function state(): AiUsageState {
  const existing = globalThis[GLOBAL_KEY as keyof typeof globalThis] as
    | AiUsageState
    | undefined;
  if (existing) return existing;
  const created = initialState();
  globalThis.__shortsStudioAiUsage = created;
  return created;
}

function finiteToken(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.round(value);
}

function normalizeTokens(tokens?: AiTokenUsage): Required<AiTokenUsage> {
  const input = finiteToken(tokens?.input) ?? 0;
  const output = finiteToken(tokens?.output) ?? 0;
  const reportedTotal = finiteToken(tokens?.total);
  return {
    input,
    output,
    total: reportedTotal ?? input + output
  };
}

export function recordAiUsage(record: AiUsageRecord): void {
  const s = state();
  const tokens = normalizeTokens(record.tokens);
  const at = record.at ?? Date.now();

  s.totalCalls += 1;
  if (record.kind === "vision") s.visionCalls += 1;
  else s.plannerCalls += 1;

  s.inputTokens += tokens.input;
  s.outputTokens += tokens.output;
  s.totalTokens += tokens.total;

  const bucket = s.byProvider[record.provider] ?? {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  };
  bucket.calls += 1;
  bucket.inputTokens += tokens.input;
  bucket.outputTokens += tokens.output;
  bucket.totalTokens += tokens.total;
  s.byProvider[record.provider] = bucket;

  s.last = {
    provider: record.provider,
    kind: record.kind,
    model: record.model,
    apiKeyName: record.apiKeyName,
    ...(tokens.input > 0 ? { inputTokens: tokens.input } : {}),
    ...(tokens.output > 0 ? { outputTokens: tokens.output } : {}),
    ...(tokens.total > 0 ? { totalTokens: tokens.total } : {}),
    at
  };
}

export function getAiUsageSnapshot(): AiUsageSnapshot {
  const s = state();
  return {
    totalCalls: s.totalCalls,
    plannerCalls: s.plannerCalls,
    visionCalls: s.visionCalls,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    totalTokens: s.totalTokens,
    byProvider: Object.fromEntries(
      Object.entries(s.byProvider).map(([provider, bucket]) => [
        provider,
        { ...bucket }
      ])
    ),
    last: s.last ? { ...s.last } : null
  };
}

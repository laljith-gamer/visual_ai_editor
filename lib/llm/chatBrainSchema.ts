// =====================================================================
// lib/llm/chatBrainSchema.ts
//
// Strict, typed schema + runtime validator for the text-only Chat Brain
// intent/answer resolver, plus a PRIVACY-SAFE payload builder.
//
// The payload builder is the single privacy boundary: it accepts only
// compact TEXT STATE and, by construction, can never carry video bytes,
// frames, thumbnails, raw audio, transcript bodies, API keys, file paths, or
// binary data. The validator rejects anything that isn't a well-formed
// ChatBrainIntent so a bad/garbage LLM response degrades to deterministic
// behaviour instead of corrupting the brief.
//
// PURE: no React, no store, no network. Unit-tested.
// =====================================================================

export type ChatBrainRoute =
  | "answer_pending_question"
  | "describe_video"
  | "create_highlight"
  | "refine_timeline"
  | "trim_to_target"
  | "read_only"
  | "confirm_pending"
  | "cancel_pending"
  | "passthrough"
  | "ask_clarifying_question";

export type ChatBrainOutputType =
  | "best_moments_reel"
  | "one_continuous_short"
  | "specific_scene"
  | "merge_as_is"
  | "unknown";

export type ChatBrainSourceScope =
  | "current_video"
  | "current_timeline"
  | "selected_videos"
  | "all_uploaded"
  | "unspecified";

export type ChatBrainFormat = "vertical" | "horizontal" | "square" | "unspecified";

export interface ChatBrainIntent {
  route: ChatBrainRoute;
  confidence: number;
  outputType?: ChatBrainOutputType;
  sourceScope?: ChatBrainSourceScope;
  contentFocus?: string[];
  includeConcepts?: string[];
  excludeConcepts?: string[];
  targetSeconds?: number | null;
  style?: string | null;
  answersPendingQuestion?: boolean;
  pendingQuestionId?: string | null;
  shouldAsk?: boolean;
  askMessage?: string | null;
  suggestions?: string[];
  normalizedUserText: string;
  reason: string;
}

const VALID_ROUTES: ReadonlySet<string> = new Set<ChatBrainRoute>([
  "answer_pending_question",
  "describe_video",
  "create_highlight",
  "refine_timeline",
  "trim_to_target",
  "read_only",
  "confirm_pending",
  "cancel_pending",
  "passthrough",
  "ask_clarifying_question"
]);

const VALID_OUTPUT_TYPES: ReadonlySet<string> = new Set<ChatBrainOutputType>([
  "best_moments_reel",
  "one_continuous_short",
  "specific_scene",
  "merge_as_is",
  "unknown"
]);

const VALID_SCOPES: ReadonlySet<string> = new Set<ChatBrainSourceScope>([
  "current_video",
  "current_timeline",
  "selected_videos",
  "all_uploaded",
  "unspecified"
]);

const VALID_FORMATS: ReadonlySet<string> = new Set<ChatBrainFormat>([
  "vertical",
  "horizontal",
  "square",
  "unspecified"
]);

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function cleanStringArray(v: unknown, cap = 8): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string") {
      const s = item.trim().slice(0, 60);
      if (s) out.push(s);
    }
    if (out.length >= cap) break;
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Validate + normalize an untrusted object (parsed LLM JSON) into a strict
 * ChatBrainIntent, or return null when it isn't usable. Defensive: unknown
 * enum values are dropped, numbers are clamped, strings are length-capped.
 */
export function parseChatBrainIntent(raw: unknown): ChatBrainIntent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  if (typeof o.route !== "string" || !VALID_ROUTES.has(o.route)) return null;
  const route = o.route as ChatBrainRoute;

  const confidence =
    typeof o.confidence === "number" && Number.isFinite(o.confidence)
      ? clamp01(o.confidence)
      : 0;

  const normalizedUserText =
    typeof o.normalizedUserText === "string" ? o.normalizedUserText.trim().slice(0, 400) : "";
  const reason = typeof o.reason === "string" ? o.reason.trim().slice(0, 300) : "";

  const intent: ChatBrainIntent = { route, confidence, normalizedUserText, reason };

  if (typeof o.outputType === "string" && VALID_OUTPUT_TYPES.has(o.outputType)) {
    intent.outputType = o.outputType as ChatBrainOutputType;
  }
  if (typeof o.sourceScope === "string" && VALID_SCOPES.has(o.sourceScope)) {
    intent.sourceScope = o.sourceScope as ChatBrainSourceScope;
  }
  const contentFocus = cleanStringArray(o.contentFocus);
  if (contentFocus) intent.contentFocus = contentFocus;
  const includeConcepts = cleanStringArray(o.includeConcepts);
  if (includeConcepts) intent.includeConcepts = includeConcepts;
  const excludeConcepts = cleanStringArray(o.excludeConcepts);
  if (excludeConcepts) intent.excludeConcepts = excludeConcepts;

  if (o.targetSeconds === null) {
    intent.targetSeconds = null;
  } else if (typeof o.targetSeconds === "number" && Number.isFinite(o.targetSeconds)) {
    intent.targetSeconds = Math.max(1, Math.min(3600, Math.round(o.targetSeconds)));
  }

  if (typeof o.style === "string") intent.style = o.style.trim().slice(0, 60) || null;
  else if (o.style === null) intent.style = null;

  if (typeof o.answersPendingQuestion === "boolean") {
    intent.answersPendingQuestion = o.answersPendingQuestion;
  }
  if (typeof o.pendingQuestionId === "string") {
    intent.pendingQuestionId = o.pendingQuestionId.slice(0, 64);
  } else if (o.pendingQuestionId === null) {
    intent.pendingQuestionId = null;
  }
  if (typeof o.shouldAsk === "boolean") intent.shouldAsk = o.shouldAsk;
  if (typeof o.askMessage === "string") intent.askMessage = o.askMessage.trim().slice(0, 300) || null;
  else if (o.askMessage === null) intent.askMessage = null;
  const suggestions = cleanStringArray(o.suggestions, 5);
  if (suggestions) intent.suggestions = suggestions;

  return intent;
}

// ---------------------------------------------------------------------
// Privacy-safe payload
// ---------------------------------------------------------------------

/** The ONLY shape sent to the text brain. No media fields exist here. */
export interface ChatBrainPayload {
  task: "resolve";
  schema: "intent-router-v1";
  userMessage: string;
  previousAssistantMessage?: string;
  pendingQuestion?: { id: string; prompt: string; suggestions?: string[] };
  pendingActionKind?: string;
  activeTargetSeconds?: number | null;
  /** A compact, running-goal SUBJECT carried across turns (e.g. the current
   *  plan's primary focus "combat moments"). Lets the router combine a prior
   *  subject with a new duration-only turn (and vice-versa) instead of
   *  reasoning from the latest sentence alone. Text-only; never media. */
  activeSubject?: string;
  timelineClipCount?: number;
  selectedSourceCount?: number;
  sourceName?: string;
  briefSummary?: string;
}

export interface ChatBrainPayloadInput {
  userMessage: string;
  previousAssistantMessage?: string | null;
  pendingQuestion?: { id: string; prompt: string; suggestions?: string[] } | null;
  pendingActionKind?: string | null;
  activeTargetSeconds?: number | null;
  activeSubject?: string | null;
  timelineClipCount?: number;
  selectedSourceCount?: number;
  sourceName?: string | null;
  briefSummary?: string | null;
}

/** Keys that must NEVER appear in a Chat Brain payload (privacy guard). */
export const FORBIDDEN_PAYLOAD_KEYS: readonly string[] = [
  "blob",
  "videoBlob",
  "frame",
  "frames",
  "thumbnail",
  "thumbnails",
  "screenshot",
  "image",
  "imageBase64",
  "base64",
  "audio",
  "transcript",
  "transcriptBody",
  "binary",
  "buffer",
  "arrayBuffer",
  "apiKey",
  "key",
  "filePath",
  "path",
  "url"
];

/**
 * Build the privacy-safe payload. Only the allowed compact text-state fields
 * are copied; everything else is dropped. Strings are length-capped so a
 * giant message can't smuggle data or blow up the request.
 */
export function buildChatBrainPayload(input: ChatBrainPayloadInput): ChatBrainPayload {
  const payload: ChatBrainPayload = {
    task: "resolve",
    schema: "intent-router-v1",
    userMessage: (input.userMessage ?? "").slice(0, 500)
  };
  if (input.previousAssistantMessage) {
    payload.previousAssistantMessage = input.previousAssistantMessage.slice(0, 500);
  }
  if (input.pendingQuestion && typeof input.pendingQuestion.id === "string") {
    payload.pendingQuestion = {
      id: input.pendingQuestion.id.slice(0, 64),
      prompt: (input.pendingQuestion.prompt ?? "").slice(0, 300),
      ...(Array.isArray(input.pendingQuestion.suggestions)
        ? { suggestions: input.pendingQuestion.suggestions.map((s) => String(s).slice(0, 60)).slice(0, 6) }
        : {})
    };
  }
  if (input.pendingActionKind) payload.pendingActionKind = String(input.pendingActionKind).slice(0, 40);
  if (input.activeTargetSeconds === null || typeof input.activeTargetSeconds === "number") {
    payload.activeTargetSeconds = input.activeTargetSeconds;
  }
  if (input.activeSubject) payload.activeSubject = input.activeSubject.slice(0, 120);
  if (typeof input.timelineClipCount === "number") payload.timelineClipCount = input.timelineClipCount;
  if (typeof input.selectedSourceCount === "number") payload.selectedSourceCount = input.selectedSourceCount;
  if (input.sourceName) payload.sourceName = input.sourceName.slice(0, 120);
  if (input.briefSummary) payload.briefSummary = input.briefSummary.slice(0, 300);
  return payload;
}

/**
 * Defensive runtime assertion used by tests + the network layer: a payload
 * object must contain no forbidden (media/secret) keys at any depth.
 */
export function payloadHasForbiddenKeys(obj: unknown): boolean {
  const forbidden = new Set(FORBIDDEN_PAYLOAD_KEYS.map((k) => k.toLowerCase()));
  const walk = (v: unknown): boolean => {
    if (!v || typeof v !== "object") return false;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (forbidden.has(k.toLowerCase())) return true;
      if (walk(val)) return true;
    }
    return false;
  };
  return walk(obj);
}

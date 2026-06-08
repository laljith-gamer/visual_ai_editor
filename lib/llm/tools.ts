// =====================================================================
// lib/llm/tools.ts
//
// MODEL-DRIVEN TOOL ROUTER — the production replacement for the keyword/
// regex intent layer (lib/intent/*).
//
// Instead of matching hardcoded phrases ("best parts" -> promote), we ask
// the local model to read the turn + context and decide ONE of:
//   - just CHAT (answer / explain / discuss), or
//   - invoke an editor TOOL (plan / extract / promote / describe / merge /
//     edit / reset) with structured arguments.
//
// Why a JSON-mode router instead of native OpenAI `tool_calls`:
//   - Native function-calling in WebLLM is model-specific (only the ~11
//     Hermes/functionary models do it reliably) and still WIP.
//   - A JSON-mode "decision" works on ALL 150 chat models, is deterministic
//     to parse, and matches how planLocally already operates.
// When a tool-capable model IS loaded, the same schema maps cleanly onto
// native tool_calls later — this router is the portable baseline.
//
// The router OUTPUT is a typed, validated decision. It performs NO edits
// itself; the caller maps the decision onto the existing pipeline. This
// keeps understanding (model) separate from execution (app), which is the
// whole point: questions can never accidentally trigger destructive edits,
// because "chat" is a first-class decision the model must actively avoid.
// =====================================================================

import { LOCAL_LLM } from "@/lib/config";
import { ensureLocalEngine, isLocalLlmSupported } from "@/lib/llm/engine";
import { extractJsonObject } from "@/lib/util/safeJson";
import type { CapabilityTier } from "@/lib/types";
import type {
  LocalChatMessage,
  LocalLlmProgress,
  LocalPlannerContext
} from "@/lib/llm/types";

// ---------------------------------------------------------------------
// Tool catalog (the actions the assistant may take)
// ---------------------------------------------------------------------

export type ToolName =
  | "chat"
  | "plan"
  | "extract"
  | "promote"
  | "describe"
  | "merge"
  | "edit"
  | "reset";

/** Human + model-facing description of each tool. Sent in the prompt so
 *  the model knows what's available and when to pick each. Kept short and
 *  concrete — small models follow tight catalogs best. */
export const TOOL_CATALOG: Record<ToolName, string> = {
  chat: "Answer the user, explain something, or discuss the video/clips. Use this for ANY question (why/what/how), explanation, or small talk. Default when unsure.",
  plan: "Build a highlight reel about a SUBJECT the user named (e.g. 'reel of the cooking action'). Needs scenarios.",
  extract: "Grab an EXACT time slice ('first 30 seconds', '0:30 to 1:30', 'last minute').",
  promote: "Turn the briefing's already-found best parts into timeline clips. Only when a briefing exists AND the user clearly asks to use/clip/add those moments.",
  describe: "Run a fresh visual look at the whole video or a specific clip to describe what's in it.",
  merge: "Concatenate whole video sources as-is, no scoring.",
  edit: "Mechanically change the timeline: trim/drop a range, split, remove a clip.",
  reset: "Clear the timeline / start over."
};

// ---------------------------------------------------------------------
// Decision result (discriminated union)
// ---------------------------------------------------------------------

export interface ToolArgs {
  /** plan: concrete on-screen scenario descriptions. */
  scenarios?: Array<{ id: string; prompt: string }>;
  signals?: { semantic: number; motion: number; saliency: number };
  /** extract: a time slice. */
  extractRange?: {
    kind: "first" | "last" | "absolute";
    startSeconds: number;
    endSeconds: number;
  };
  /** promote: optional subset + op. */
  partIds?: string[];
  targetSeconds?: number;
  op?: "append" | "replace";
  /** describe: optional clip target + the question. */
  target?: { kind: "selected" | "index" | "whole"; index?: number };
  question?: string;
  /** edit: a mechanical operation. */
  operation?: {
    kind: "trim_first" | "trim_last" | "drop_range" | "split" | "remove_clip";
    seconds?: number;
    startSeconds?: number;
    endSeconds?: number;
  };
}

export interface ToolDecision {
  tool: ToolName;
  args: ToolArgs;
  /** A short assistant message to show the user regardless of tool. For
   *  `chat` this IS the answer; for actions it's the confirmation line. */
  message: string;
  /** 0..1 self-reported confidence; the caller may threshold on it. */
  confidence: number;
}

export type ToolRouteOutcome =
  | { handled: true; decision: ToolDecision; model: string }
  | {
      handled: false;
      reason:
        | "disabled"
        | "unsupported"
        | "load_failed"
        | "infer_failed"
        | "bad_json"
        | "aborted";
    };

// ---------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------

const ROUTER_SYSTEM = `You are the routing brain of a browser video editor. Read the latest user message and the context, then output ONE JSON object choosing what to do. JSON ONLY — first char "{", last char "}".

Shape:
{
  "tool": "chat|plan|extract|promote|describe|merge|edit|reset",
  "args": { ... depends on tool, omit when not needed ... },
  "message": "one short sentence to the user",
  "confidence": 0.0-1.0
}

Tools:
${Object.entries(TOOL_CATALOG)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join("\n")}

CRITICAL rules:
- A QUESTION or request to EXPLAIN/DESCRIBE/why/what/how is ALWAYS "chat" (or "describe" if it needs a fresh visual look). NEVER turn a question into plan/extract/promote/edit/merge/reset. Those change the user's timeline; a question must never do that.
- Only pick promote when a briefing exists AND the user clearly says to use/clip/add those moments ("use those", "clip the best parts", "add them").
- Only pick edit/extract when the user gives a concrete operation or time range.
- When unsure, choose "chat" and answer or ask a brief question.
- "message" is always present. For "chat", message is your actual answer.

Tool args:
- plan: { "scenarios": [{ "id": "x", "prompt": "concrete on-screen description" }], "signals": { "semantic": 0.7, "motion": 0.2, "saliency": 0.1 } }
- extract: { "extractRange": { "kind": "first|last|absolute", "startSeconds": N, "endSeconds": N } }
- promote: { "partIds": [".."]?, "op": "append|replace", "targetSeconds": N? }
- describe: { "target": { "kind": "selected|index|whole", "index": N? }, "question": ".." }
- edit: { "operation": { "kind": "trim_first|trim_last|drop_range|split|remove_clip", "seconds": N?, "startSeconds": N?, "endSeconds": N? } }
- merge: {}  reset: {}  chat: {}`;

/** Build the per-turn user payload for the router. Token-lean. */
function buildRouterUserPrompt(
  messages: LocalChatMessage[],
  context?: ToolRouteContext
): string {
  const lines: string[] = [];
  if (context?.videoMeta?.duration) {
    lines.push(`VIDEO DURATION: ${Math.round(context.videoMeta.duration)}s`);
  }
  if (typeof context?.highlightsCount === "number") {
    lines.push(`TIMELINE CLIPS: ${context.highlightsCount}`);
  }
  if (context?.hasBriefing) {
    lines.push(
      `BRIEFING AVAILABLE: yes (${context.briefingPartCount ?? 0} best parts) — promote/describe can reference it.`
    );
  } else {
    lines.push("BRIEFING AVAILABLE: no");
  }
  if (context?.treeOutline) {
    lines.push("FOOTAGE OUTLINE:");
    lines.push(context.treeOutline);
  }
  const recent = messages.slice(-5);
  lines.push("CONVERSATION:");
  for (const m of recent) {
    if (m.role === "system") continue;
    lines.push(`${m.role === "user" ? "USER" : "ASSISTANT"}: ${m.content.slice(0, 400)}`);
  }
  lines.push("");
  lines.push("Output the single routing JSON now.");
  return lines.join("\n");
}

export interface ToolRouteContext extends LocalPlannerContext {
  hasBriefing?: boolean;
  briefingPartCount?: number;
}

export interface ToolRouteOptions {
  tier: CapabilityTier;
  enabled?: boolean;
  messages: LocalChatMessage[];
  context?: ToolRouteContext;
  model?: string;
  onProgress?: (p: LocalLlmProgress) => void;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------

/**
 * Route a turn with the local model. Returns a typed decision the caller
 * maps onto the pipeline, or { handled: false } so it can fall through.
 * Never throws.
 */
export async function routeTurn(
  opts: ToolRouteOptions
): Promise<ToolRouteOutcome> {
  if (!(opts.enabled ?? false)) return { handled: false, reason: "disabled" };
  if (!isLocalLlmSupported(opts.tier)) {
    return { handled: false, reason: "unsupported" };
  }
  if (opts.signal?.aborted) return { handled: false, reason: "aborted" };

  const model = opts.model ?? localChatModel(opts.tier);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let engine: any;
  try {
    engine = await ensureLocalEngine({ model, onProgress: opts.onProgress });
  } catch {
    return { handled: false, reason: "load_failed" };
  }
  if (opts.signal?.aborted) return { handled: false, reason: "aborted" };

  let raw: string;
  try {
    const reply = await engine.chat.completions.create({
      messages: [
        { role: "system", content: ROUTER_SYSTEM },
        { role: "user", content: buildRouterUserPrompt(opts.messages, opts.context) }
      ],
      temperature: LOCAL_LLM.temperature,
      seed: LOCAL_LLM.seed,
      max_tokens: LOCAL_LLM.maxTokens,
      response_format: { type: "json_object" }
    });
    raw = reply?.choices?.[0]?.message?.content ?? "";
  } catch {
    return { handled: false, reason: "infer_failed" };
  }

  const parsed = extractJsonObject<Record<string, unknown>>(raw);
  if (!parsed) return { handled: false, reason: "bad_json" };

  const decision = coerceDecision(parsed);
  if (!decision) return { handled: false, reason: "bad_json" };

  return { handled: true, decision, model };
}

// ---------------------------------------------------------------------
// Validation / coercion — keep the model honest
// ---------------------------------------------------------------------

const VALID_TOOLS: ToolName[] = [
  "chat",
  "plan",
  "extract",
  "promote",
  "describe",
  "merge",
  "edit",
  "reset"
];

/**
 * Validate a raw routing object (already parsed from JSON) into a typed
 * ToolDecision, or null when it's unusable. Exported and PURE so it can be
 * unit-tested without a GPU and reused anywhere a decision needs checking.
 *
 * Safety contract enforced here:
 *   - Unknown tool name → "chat".
 *   - An action tool missing required args is DEMOTED to "chat" (never a
 *     malformed/destructive action).
 *   - A "chat" decision with no message → null (caller streams a real
 *     answer instead of a hollow confirmation).
 */
export function validateToolDecision(
  o: Record<string, unknown>
): ToolDecision | null {
  return coerceDecision(o);
}

function coerceDecision(o: Record<string, unknown>): ToolDecision | null {
  const toolRaw = typeof o.tool === "string" ? o.tool.trim().toLowerCase() : "";
  const tool = (VALID_TOOLS as string[]).includes(toolRaw)
    ? (toolRaw as ToolName)
    : "chat"; // unknown tool → safest default
  const message = str(o.message, tool === "chat" ? "" : "On it.");
  // A chat decision with no message is useless — reject so caller streams
  // a real chat answer instead.
  if (tool === "chat" && !message) return null;

  const args = coerceArgs(tool, o.args);
  // SAFETY: if an action tool failed to produce its required args, demote
  // to chat rather than firing a malformed/destructive action.
  if (tool !== "chat" && !args) {
    return {
      tool: "chat",
      args: {},
      message: message || "Could you give me a bit more detail?",
      confidence: clamp01(num(o.confidence) ?? 0.4)
    };
  }

  return {
    tool,
    args: args ?? {},
    message,
    confidence: clamp01(num(o.confidence) ?? 0.6)
  };
}

/** Returns validated args, or null when a non-chat tool lacks required
 *  fields (signalling the caller to demote to chat). */
function coerceArgs(tool: ToolName, raw: unknown): ToolArgs | null {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  switch (tool) {
    case "chat":
    case "merge":
    case "reset":
      return {};
    case "plan": {
      const scenarios = coerceScenarios(o.scenarios);
      const signals = coerceSignals(o.signals, scenarios.length > 0);
      if (scenarios.length === 0 && signals.semantic > 0) return null;
      return { scenarios, signals };
    }
    case "extract": {
      const extractRange = coerceExtract(o.extractRange);
      if (!extractRange) return null;
      return { extractRange };
    }
    case "promote": {
      const partIds = Array.isArray(o.partIds)
        ? o.partIds.filter((x): x is string => typeof x === "string").slice(0, 12)
        : undefined;
      const op = o.op === "replace" ? "replace" : "append";
      const targetSeconds =
        num(o.targetSeconds) != null
          ? Math.max(2, Math.min(600, num(o.targetSeconds) as number))
          : undefined;
      return { ...(partIds && partIds.length ? { partIds } : {}), op, ...(targetSeconds != null ? { targetSeconds } : {}) };
    }
    case "describe": {
      const t = o.target as Record<string, unknown> | undefined;
      const kind =
        t?.kind === "index" || t?.kind === "selected" || t?.kind === "whole"
          ? t.kind
          : "whole";
      const index = num(t?.index);
      const question = str(o.question, "");
      return {
        target: { kind, ...(index != null ? { index: Math.max(0, Math.round(index)) } : {}) },
        ...(question ? { question } : {})
      };
    }
    case "edit": {
      const op = o.operation as Record<string, unknown> | undefined;
      const k = op?.kind;
      const validKinds = ["trim_first", "trim_last", "drop_range", "split", "remove_clip"];
      if (!op || typeof k !== "string" || !validKinds.includes(k)) return null;
      const operation: NonNullable<ToolArgs["operation"]> = {
        kind: k as NonNullable<ToolArgs["operation"]>["kind"]
      };
      const seconds = num(op.seconds);
      const startSeconds = num(op.startSeconds);
      const endSeconds = num(op.endSeconds);
      if (seconds != null) operation.seconds = Math.max(0, seconds);
      if (startSeconds != null) operation.startSeconds = Math.max(0, startSeconds);
      if (endSeconds != null) operation.endSeconds = Math.max(0, endSeconds);
      // drop_range needs a range; trim_* needs seconds.
      if (k === "drop_range" && (startSeconds == null || endSeconds == null)) return null;
      if ((k === "trim_first" || k === "trim_last") && seconds == null) return null;
      return { operation };
    }
    default:
      return {};
  }
}

function coerceScenarios(raw: unknown): Array<{ id: string; prompt: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ id: string; prompt: string }> = [];
  for (let i = 0; i < raw.length && out.length < 6; i++) {
    const s = raw[i] as Record<string, unknown> | null;
    if (!s || typeof s !== "object") continue;
    const prompt = typeof s.prompt === "string" ? s.prompt.trim().slice(0, 200) : "";
    if (!prompt) continue;
    const id = typeof s.id === "string" && s.id.trim() ? s.id.trim().slice(0, 24) : `s${out.length + 1}`;
    out.push({ id, prompt });
  }
  return out;
}

function coerceSignals(
  raw: unknown,
  hasScenarios: boolean
): { semantic: number; motion: number; saliency: number } {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  let sem = num(o.semantic);
  let mot = num(o.motion);
  let sal = num(o.saliency);
  if (sem == null && mot == null && sal == null) {
    return hasScenarios
      ? { semantic: 0.7, motion: 0.2, saliency: 0.1 }
      : { semantic: 0, motion: 0.6, saliency: 0.4 };
  }
  sem = clamp01(sem ?? 0);
  mot = clamp01(mot ?? 0);
  sal = clamp01(sal ?? 0);
  const sum = sem + mot + sal;
  if (sum <= 0) return { semantic: 0, motion: 0.6, saliency: 0.4 };
  return { semantic: sem / sum, motion: mot / sum, saliency: sal / sum };
}

function coerceExtract(
  raw: unknown
): { kind: "first" | "last" | "absolute"; startSeconds: number; endSeconds: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const kind = o.kind === "first" || o.kind === "last" || o.kind === "absolute" ? o.kind : "absolute";
  const start = num(o.startSeconds);
  const end = num(o.endSeconds);
  if (start == null || end == null) return null;
  if (end <= start && kind !== "last") return null;
  return { kind, startSeconds: Math.max(0, start), endSeconds: Math.max(0, end) };
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

function localChatModel(tier: CapabilityTier): string {
  // Reuse the tier→model mapping from config without importing engine's
  // private selector (avoids a cycle); mirrors localModelForTier.
  if (tier === "high") return LOCAL_LLM.modelHigh;
  if (tier === "mid") return LOCAL_LLM.modelMid;
  return LOCAL_LLM.modelLow;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const p = Number(v);
    if (Number.isFinite(p)) return p;
  }
  return null;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

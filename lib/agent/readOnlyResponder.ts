// =====================================================================
// lib/agent/readOnlyResponder.ts
//
// The READ-ONLY conversation lane's answerer. Given a classified
// read-only intent + a snapshot of the current editor state, it produces a
// natural, state-grounded explanation. It is the improved successor to the
// template-only metaAnswer (which it reuses for the deterministic core).
//
// HARD CONTRACT (read-only): it NEVER mutates highlights / plan /
// transitions / selection / render state, never runs analysis, never calls
// the planner, transition parser or render. It only READS the state passed
// to it.
//
// Answer generation is two-tier:
//   - Preferred: if a text generator (`generate`) is injected (a local/cloud
//     LLM), build a strict read-only prompt from a structured state summary
//     and use its natural answer — but only if it passes a safety check
//     (non-trivial and does not falsely claim it just edited something).
//   - Fallback: a deterministic, state-grounded answer (always available,
//     no dependency, fully unit-testable).
//
// PURE: the only value import is the capability matrix (itself runtime-import
// free) + the deterministic metaAnswer, so this stays node-testable.
// =====================================================================

import { answerMetaQuestion, type MetaAnswerState } from "./metaAnswer";
import type { MetaQuestion, MetaQuestionKind } from "../intent/metaQuestions";
import type { ConversationIntent, ConversationTarget } from "../intent/conversationIntent";
import { CAPABILITY_MATRIX } from "../agentic-intake/capabilityMatrix";

/** State the responder may READ. Superset of MetaAnswerState. */
export interface ReadOnlyState extends MetaAnswerState {
  /** Current project status label (idle/ready/completed/rendering/…). */
  renderStatus?: string;
  hasRenderedOutput?: boolean;
  /** Recent activity-log summaries, newest last (optional). */
  activity?: string[];
}

/** Phrases a read-only answer must NOT contain — they'd falsely imply the
 *  responder mutated the project just now. */
const ACTION_CLAIM =
  /\b(i (?:just |now )?(?:changed|edited|updated|added|removed|deleted|trimmed|rendered|exported|applied|modified|adjusted|moved|replaced|re-?arranged|created))\b/i;

function targetToMetaKind(target: ConversationTarget): MetaQuestionKind {
  switch (target) {
    case "capability":
      return "capability_explanation";
    case "render":
      return "what_will_happen";
    case "selected_clip":
      return "why_clip_selected";
    case "plan":
      return "why_plan";
    case "history":
      return "what_changed";
    case "timeline":
    case "last_action":
    case "source_video":
    case "unknown":
    default:
      return "explain_previous_changes";
  }
}

// ---------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------

export async function answerReadOnly(
  intent: ConversationIntent,
  state: ReadOnlyState,
  opts: { generate?: (system: string, user: string) => Promise<string> } = {}
): Promise<string> {
  const deterministic = deterministicAnswer(intent, state);

  // Capability / identity answers are scripted and honesty-critical (feature
  // support, which model is running). Never let a small local model paraphrase
  // them — it tends to over-claim. Always use the deterministic answer.
  if (intent.target === "capability") return deterministic;

  if (opts.generate) {
    try {
      const { system, user } = buildReadOnlyAnswerPrompt(
        state.questionText ?? "",
        buildStateSummary(state),
        buildCapabilitySummary()
      );
      const out = (await opts.generate(system, user)).trim();
      // Accept only a substantive, non-action-claiming answer.
      if (out.length >= 12 && !ACTION_CLAIM.test(out)) {
        return intent.ambiguous ? `${out}${ambiguousSuffix()}` : out;
      }
    } catch {
      // fall through to deterministic
    }
  }
  return deterministic;
}

/** Synchronous deterministic answer — always available. */
export function deterministicAnswer(intent: ConversationIntent, state: ReadOnlyState): string {
  let answer: string;
  if (intent.target === "source_video") {
    answer = answerSourceUntouched(state);
  } else {
    const q: MetaQuestion = {
      kind: targetToMetaKind(intent.target),
      confidence: intent.confidence,
      target: metaTargetFor(intent.target)
    };
    answer = answerMetaQuestion(q, state);
    answer = augmentWithRenderStatus(intent, state, answer);
  }
  return intent.ambiguous ? `${answer}${ambiguousSuffix()}` : answer;
}

// ---------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------

function answerSourceUntouched(state: ReadOnlyState): string {
  const n = state.highlights.length;
  const lines = [
    "No — I have not changed your original video. Editing here only records in/out points and an arrangement on the timeline; your uploaded source file is never modified.",
    n > 0
      ? `Right now the timeline references ${n} clip${n === 1 ? "" : "s"} from your source${state.sources.length > 1 ? "s" : ""}.`
      : "There are no clips on the timeline yet.",
    "Rendering exports a brand-new video file and still leaves the source untouched."
  ];
  return lines.join(" ");
}

function augmentWithRenderStatus(
  intent: ConversationIntent,
  state: ReadOnlyState,
  answer: string
): string {
  if (intent.target !== "render") return answer;
  if (state.hasRenderedOutput) {
    return `${answer}\n\nThere's already a rendered output from a previous run — rendering again replaces it and never touches the source.`;
  }
  return answer;
}

function ambiguousSuffix(): string {
  return "\n\nI've only explained things here — I haven't changed anything. If you'd like me to actually apply that change, just say so and I'll do it.";
}

function metaTargetFor(target: ConversationTarget): MetaQuestion["target"] {
  switch (target) {
    case "capability":
      return "capability";
    case "render":
      return "render";
    case "selected_clip":
      return "clip";
    case "plan":
      return "plan";
    case "history":
      return "history";
    case "timeline":
      return "timeline";
    default:
      return "last_action";
  }
}

// ---------------------------------------------------------------------
// State + capability summaries (for the optional LLM answer path)
// ---------------------------------------------------------------------

export function buildStateSummary(state: ReadOnlyState): string {
  const lines: string[] = [];
  const n = state.highlights.length;
  lines.push(`Timeline: ${n === 0 ? "empty (no edit applied yet)" : `${n} clip(s)`}.`);
  if (n > 0) {
    const total = state.highlights.reduce((a, c) => a + Math.max(0, c.end - c.start), 0);
    lines.push(`Total timeline length: ~${total.toFixed(1)}s.`);
    const withReasons = state.highlights.filter((c) => (c.reason || c.label || "").trim());
    if (withReasons.length > 0) {
      lines.push(
        `Clip reasons: ${withReasons
          .slice(0, 6)
          .map((c) => `"${(c.reason || c.label || "").trim()}"`)
          .join(", ")}.`
      );
    }
  }
  if (state.selectedClipId) {
    const sel = state.highlights.find((c) => c.id === state.selectedClipId);
    if (sel) lines.push(`Selected clip: ${sel.start.toFixed(1)}s–${sel.end.toFixed(1)}s${sel.reason ? ` (${sel.reason})` : ""}.`);
  }
  if (state.plan) {
    const bits: string[] = [];
    if (typeof state.plan.targetShortSeconds === "number") {
      bits.push(`${state.plan.targetShortSeconds}s target${state.plan.userSpecifiedDuration ? " (user-set)" : ""}`);
    }
    if (state.plan.format) bits.push(state.plan.format);
    if (state.plan.transition) bits.push(`${state.plan.transition} transition`);
    const prompts = (state.plan.scenarios ?? []).map((s) => s.prompt).filter(Boolean);
    if (prompts.length) bits.push(`looking for: ${prompts.slice(0, 5).join("; ")}`);
    if (bits.length) lines.push(`Plan: ${bits.join(", ")}.`);
  } else {
    lines.push("Plan: none yet.");
  }
  if (state.boundaryTransitions.length > 0) {
    const types = Array.from(new Set(state.boundaryTransitions.map((t) => t.type)));
    lines.push(`Transitions: ${types.join(", ")} across ${state.boundaryTransitions.length} cut(s).`);
  }
  if (state.sources.length > 0) {
    lines.push(`Sources: ${state.sources.map((s) => s.name).slice(0, 5).join(", ")}.`);
  }
  if (state.renderStatus) lines.push(`Status: ${state.renderStatus}.`);
  if (state.hasRenderedOutput) lines.push("A rendered output already exists.");
  if (state.activity && state.activity.length > 0) {
    lines.push(`Recent actions: ${state.activity.slice(-5).join(" → ")}.`);
  }
  lines.push("The original source video has not been modified.");
  return lines.join("\n");
}

export function buildCapabilitySummary(): string {
  const supported: string[] = [];
  const partial: string[] = [];
  const unsupported: string[] = [];
  for (const [key, info] of Object.entries(CAPABILITY_MATRIX)) {
    const label = key.replace(/_/g, " ");
    if (info.status === "supported") supported.push(label);
    else if (info.status === "partial") partial.push(`${label} (${info.note ?? "approximate"})`);
    else unsupported.push(label);
  }
  return [
    `Supported: ${supported.join(", ")}.`,
    `Partial / approximate: ${partial.join(", ")}.`,
    `Not yet implemented (must NOT be claimed as applied): ${unsupported.join(", ")}.`
  ].join("\n");
}

export function buildReadOnlyAnswerPrompt(
  question: string,
  stateSummary: string,
  capabilitySummary: string
): { system: string; user: string } {
  const system =
    "You are the explanation layer of a video editor. You answer questions about why the current edit looks the way it does. You must not suggest that you changed anything now. You must not claim unsupported features were applied. Explain only from the provided state. If information is missing, say so.";
  const user = `User question:
${question}

Current editor state:
${stateSummary}

Capabilities:
${capabilitySummary}

Write a clear, friendly answer. Mention, where relevant:
- what is currently on the timeline
- why clips were selected if reasons exist
- what plan/settings influenced the result
- that the source video was not modified
- any renderer limitations that matter
- what is unknown if an exact diff/history is unavailable

Do not propose new edits unless asked. Do not claim you just changed anything.`;
  return { system, user };
}

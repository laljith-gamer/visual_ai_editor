// =====================================================================
// lib/agent/metaAnswer.ts
//
// Answers a meta/explanation question from CURRENT state — read-only.
//
// It NEVER mutates the timeline, never runs analysis, never claims it
// edited anything. It only reads what's already there (plan, highlights,
// selected clip, transitions, memory, recent messages) and explains it
// honestly. When information is unavailable it says so plainly rather than
// inventing a step-by-step diff.
//
// PURE: all imports are type-only (erased at runtime), so it carries no
// runtime dependency and is trivially unit-testable with `node --test`.
// =====================================================================

import type { MetaQuestion } from "../intent/metaQuestions";

/** A clip as the answerer needs to see it (subset of Highlight). */
export interface MetaAnswerClip {
  id: string;
  start: number;
  end: number;
  label?: string;
  reason?: string;
  sourceId?: string;
  score?: number;
}

/** Subset of the plan the answerer reads. */
export interface MetaAnswerPlan {
  targetShortSeconds?: number;
  userSpecifiedDuration?: boolean;
  format?: string;
  transition?: string;
  scenarios?: Array<{ id: string; prompt: string }>;
  rationale?: string;
}

export interface MetaAnswerTransition {
  index: number;
  type: string;
  mode?: string;
  render?: string;
  exact?: boolean;
  note?: string;
}

export interface MetaAnswerMemory {
  duration?: number;
  format?: string;
  styles: string[];
  keep: string[];
  skip: string[];
}

/** Everything the answerer may read. All optional/empty-safe. */
export interface MetaAnswerState {
  /** The meta question text (used to tailor capability answers). */
  questionText?: string;
  plan: MetaAnswerPlan | null;
  highlights: MetaAnswerClip[];
  selectedClipId: string | null;
  boundaryTransitions: MetaAnswerTransition[];
  memory: MetaAnswerMemory;
  sources: Array<{ id: string; name: string }>;
  lastAssistantMessage?: string | null;
  lastUserMessage?: string | null;
}

/** Honest, static description of the renderer's transition support. The
 *  renderer applies only straight cuts, fades and a crossfade (rendered as
 *  a quick fade dip). Anything richer is mapped down, never faked. */
const TRANSITION_LIMIT_NOTE =
  "The renderer currently applies only straight cuts, fades, and a crossfade " +
  "(rendered as a quick fade dip). Richer transitions like slide, zoom, " +
  "glitch, whip or dip-to-black are mapped down to the closest supported one " +
  "and never claimed as fully rendered.";

const NO_EDIT_YET = "No edit has been applied yet.";

// Identity / "what model / who are you" questions. Answered honestly about the
// brain that's actually running rather than the "no edit yet" explanation.
const IDENTITY_RE =
  /\byour\s+(?:model|llm|engine|brain|ai|name)\b|\bwhat(?:'?s)?\s+(?:ai\s+)?(?:model|llm)\b|\bwhich\s+(?:ai\s+)?(?:model|llm)\b|\bwho\s+are\s+you\b|\bare\s+you\s+(?:an?\s+)?(?:ai|llm|gpt|chatgpt|a\s+bot|human|real|sentient)\b|\bwhat(?:'?s)?\s+your\s+name\b|\bwhat(?:'?s)?\s+powering\s+you\b/;

/** Honest description of WHAT is doing the thinking. The default build is
 *  local-first: deterministic parsing/scoring plus a small on-device model;
 *  cloud models are used only when the deployment is configured with a key. */
function answerIdentity(): string {
  return [
    "I'm the editing assistant built into this app — \u201cyour editor\u201d — not a separate chatbot persona, so I don't have a brand name.",
    "How I actually work: a lot of what I do is deterministic code (reading your request, scoring frames for motion and visual saliency, assembling the timeline). To understand free-text requests this build runs a small model on-device in your browser via WebGPU (WebLLM \u2014 Llama-3.2-1B by default), and falls back to deterministic parsing when that isn't available.",
    "By default this is a local-only, private build, which is light and fast to start but less capable and slower at reasoning than a large cloud model. If the deployment is configured with a cloud key (OpenRouter, Gemini, or Groq), those handle the planning instead and the results are noticeably stronger."
  ].join("\n\n");
}

export function answerMetaQuestion(question: MetaQuestion, state: MetaAnswerState): string {
  switch (question.kind) {
    case "why_clip_selected":
      return answerWhyClip(state);
    case "why_plan":
      return answerWhyPlan(state);
    case "what_changed":
      return answerWhatChanged(state);
    case "what_will_happen":
      return answerWhatWillHappen(state);
    case "capability_explanation":
      return answerCapability(state);
    case "explain_previous_changes":
    case "unknown":
    default:
      return answerExplainChanges(state);
  }
}

// ---------------------------------------------------------------------
// Per-kind answers
// ---------------------------------------------------------------------

function answerExplainChanges(state: MetaAnswerState): string {
  const clips = state.highlights;
  if (clips.length === 0) {
    return `${NO_EDIT_YET} I haven't changed your timeline or the source video — there are no clips yet. Tell me what to make and I'll build it.`;
  }

  const lines: string[] = ["Here's why the timeline looks the way it does:"];
  let n = 1;

  // 1. Clip selection.
  const planScenarios = state.plan?.scenarios ?? [];
  if (planScenarios.length > 0) {
    const prompts = planScenarios.map((s) => s.prompt).filter(Boolean).slice(0, 4);
    lines.push(
      `${n++}. I selected ${clips.length} clip${clips.length === 1 ? "" : "s"} because they matched the current plan${
        prompts.length > 0 ? ` (${prompts.join("; ")})` : ""
      }.`
    );
  } else {
    lines.push(
      `${n++}. I selected ${clips.length} clip${clips.length === 1 ? "" : "s"} based on the strongest moments found in the footage.`
    );
  }

  // 2. Duration.
  const total = totalSeconds(clips);
  const target = state.plan?.targetShortSeconds;
  if (typeof target === "number") {
    lines.push(
      `${n++}. The timeline is about ${fmtSecs(total)} because the target duration was ${target}s${
        state.plan?.userSpecifiedDuration ? " (you asked for that length)" : ""
      }.`
    );
  } else {
    lines.push(`${n++}. The timeline is about ${fmtSecs(total)} total across those clips.`);
  }

  // 3. Transitions (honest renderer limitation).
  lines.push(`${n++}. ${describeTransitionsForExplain(state)}`);

  // 4. Source untouched.
  lines.push(
    `${n++}. I did not change the source video itself — only the timeline clip arrangement.`
  );

  return lines.join("\n");
}

function answerWhyClip(state: MetaAnswerState): string {
  const clip = pickClip(state);
  if (!clip) {
    return `${NO_EDIT_YET} No clip is selected, so there's nothing to explain yet. Add or pick a clip and I'll tell you why it's there.`;
  }
  const sourceName = clip.sourceId
    ? state.sources.find((s) => s.id === clip.sourceId)?.name
    : undefined;
  const reason = clip.reason?.trim() || clip.label?.trim();
  const parts: string[] = [];
  parts.push(
    reason
      ? `This clip was selected because: ${reason}.`
      : "This clip is on the timeline as part of the current edit."
  );
  parts.push(`It runs from ${fmtSecs(clip.start)} to ${fmtSecs(clip.end)} (${fmtSecs(clip.end - clip.start)}).`);
  if (sourceName) parts.push(`It comes from "${sourceName}".`);
  if (typeof clip.score === "number") {
    parts.push(`Its match score was ${(clip.score * 100).toFixed(0)}%.`);
  }
  return parts.join(" ");
}

function answerWhyPlan(state: MetaAnswerState): string {
  const plan = state.plan;
  if (!plan) {
    return "There's no active plan yet — I haven't planned an edit. Tell me what to make (e.g. \"a 30s vertical highlights reel\") and I'll build one.";
  }
  const lines: string[] = ["Here's the plan I'm working from (no new analysis was run to answer this):"];
  if (typeof plan.targetShortSeconds === "number") {
    lines.push(
      `- Target length: ${plan.targetShortSeconds}s${plan.userSpecifiedDuration ? " (you specified it)" : " (inferred default)"}.`
    );
  }
  if (plan.format) lines.push(`- Format: ${plan.format}.`);
  if (plan.transition) lines.push(`- Transition: ${plan.transition}.`);
  const prompts = (plan.scenarios ?? []).map((s) => s.prompt).filter(Boolean);
  if (prompts.length > 0) {
    lines.push(`- Looking for: ${prompts.slice(0, 6).join("; ")}.`);
  }
  if (plan.rationale) lines.push(`- Rationale: ${plan.rationale}`);
  return lines.join("\n");
}

function answerWhatChanged(state: MetaAnswerState): string {
  const clips = state.highlights;
  if (clips.length === 0) {
    return `${NO_EDIT_YET} The timeline is empty and the source video is untouched.`;
  }
  const lines: string[] = ["Here's the current edit state:"];
  lines.push(`- Clips on the timeline: ${clips.length} (${fmtSecs(totalSeconds(clips))} total).`);

  const sourceIds = Array.from(new Set(clips.map((c) => c.sourceId).filter(Boolean))) as string[];
  if (sourceIds.length > 0) {
    const names = sourceIds
      .map((id) => state.sources.find((s) => s.id === id)?.name ?? id)
      .slice(0, 4);
    lines.push(`- Source${names.length === 1 ? "" : "s"} used: ${names.join(", ")}.`);
  }
  if (state.plan) {
    const bits: string[] = [];
    if (typeof state.plan.targetShortSeconds === "number") bits.push(`${state.plan.targetShortSeconds}s target`);
    if (state.plan.format) bits.push(state.plan.format);
    if (bits.length > 0) lines.push(`- Plan: ${bits.join(", ")}.`);
  }
  if (state.boundaryTransitions.length > 0) {
    const types = Array.from(new Set(state.boundaryTransitions.map((t) => t.type)));
    lines.push(`- Transitions: ${state.boundaryTransitions.length} (${types.join(", ")}).`);
  }
  lines.push(
    "I don't keep an exact step-by-step diff, so this is the current state rather than a precise change log."
  );
  return lines.join("\n");
}

function answerWhatWillHappen(state: MetaAnswerState): string {
  const clips = state.highlights;
  if (clips.length === 0) {
    return "There's nothing to render yet — the timeline is empty. Add at least one clip first.";
  }
  const fmt = state.plan?.format ?? "vertical";
  const transition = state.plan?.transition && state.plan.transition !== "none" ? state.plan.transition : "straight cuts";
  const lines: string[] = [];
  lines.push(
    `If you render now, I'll stitch ${clips.length} clip${clips.length === 1 ? "" : "s"} (~${fmtSecs(totalSeconds(clips))} total) into a ${fmt} video using ${transition} at the joins.`
  );
  lines.push(TRANSITION_LIMIT_NOTE);
  lines.push("The source videos are not modified — rendering only assembles the timeline you see.");
  return lines.join(" ");
}

function answerCapability(state: MetaAnswerState): string {
  const q = (state.questionText ?? "").toLowerCase();
  // Identity / "what model are you" → explain the brain honestly.
  if (IDENTITY_RE.test(q)) {
    return answerIdentity();
  }
  // Transition/fade-specific question → explain the render limitation.
  if (/\b(fade|crossfade|cross-fade|transitions?)\b/.test(q)) {
    return [
      "About transitions:",
      `- ${TRANSITION_LIMIT_NOTE}`,
      "- So if a plan or request mentions slide/zoom/glitch/whip, it's shown honestly as a request and rendered as the nearest supported transition (usually a cut or fade), not faked."
    ].join("\n");
  }
  // General "what can this app do".
  return [
    "Here's what I can actually do today (honestly):",
    "- Supported: trim/extract ranges, pick best-moments / highlight reels, keep one continuous clip, merge or compose multiple videos, output vertical / horizontal / square, and apply cut / fade / crossfade transitions.",
    "- Not yet rendered: slow zoom, speed changes, color grading, camera shake, letterbox bars, on-screen text overlays, burned-in captions, and added music/SFX. I'll note these as requests but won't claim they were applied.",
    "- I work on the timeline only — I never alter your original source videos."
  ].join("\n");
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function pickClip(state: MetaAnswerState): MetaAnswerClip | null {
  if (state.selectedClipId) {
    const sel = state.highlights.find((c) => c.id === state.selectedClipId);
    if (sel) return sel;
  }
  return state.highlights.length > 0 ? state.highlights[state.highlights.length - 1] : null;
}

function describeTransitionsForExplain(state: MetaAnswerState): string {
  const bts = state.boundaryTransitions;
  if (bts.length === 0) {
    return `I used straight cuts between clips. ${TRANSITION_LIMIT_NOTE}`;
  }
  const types = Array.from(new Set(bts.map((t) => t.type)));
  return `I used ${types.join(" / ")} between clips. ${TRANSITION_LIMIT_NOTE}`;
}

function totalSeconds(clips: MetaAnswerClip[]): number {
  return clips.reduce((acc, c) => acc + Math.max(0, c.end - c.start), 0);
}

function fmtSecs(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 60) return `${s % 1 === 0 ? s : s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

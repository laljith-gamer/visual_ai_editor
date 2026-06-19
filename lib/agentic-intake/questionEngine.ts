// =====================================================================
// lib/agentic-intake/questionEngine.ts
//
// Decides whether the intake layer should ASK a question or PROCEED, and
// which single question to ask. It asks the MINIMUM number of questions —
// one focused question at a time, with option chips — and reuses the
// existing ClarifyQuestion / QuickReplies shape so no second chat UI is
// needed.
//
// The order of priority reflects the worked examples in the spec:
//   source_scope → output_type → content_focus → duration → format →
//   style → text → audio → avoid
//
// PURE: no React, no store. Returns a ClarifyQuestion (the same type the
// store's pendingClarify uses) so the editor can drop it straight into
// the existing QuickReplies flow.
// =====================================================================

import type { ClarifyQuestion } from "@/lib/types";
import type { EditBrief, MissingField } from "./editBrief";

/** Decision the question engine returns. */
export interface QuestionDecision {
  /** True → ask `question`; false → enough info, proceed. */
  shouldAsk: boolean;
  /** The single highest-priority question to ask (when shouldAsk). */
  question?: ClarifyQuestion;
  /** The missing field this question targets. */
  field?: MissingField;
  /** All currently-missing high-impact fields (for debugging/telemetry). */
  missing: MissingField[];
}

/** Priority order — we ask the FIRST missing field in this list. */
const PRIORITY: MissingField[] = [
  "source_scope",
  "output_type",
  "content_focus",
  "duration",
  "format",
  "style",
  "text",
  "audio",
  "avoid"
];

/** Build the ClarifyQuestion for a given missing field. */
function buildQuestion(field: MissingField): ClarifyQuestion {
  switch (field) {
    case "source_scope":
      return {
        id: "intake-source-scope",
        prompt: "Which video should I use?",
        suggestions: ["Current video only", "Selected videos", "All uploaded videos"],
        kind: "single-choice"
      };
    case "output_type":
      return {
        id: "intake-output-type",
        prompt: "What should I make?",
        suggestions: [
          "One continuous short",
          "Best-moments reel",
          "Specific scene",
          "Merge videos as-is"
        ],
        kind: "single-choice"
      };
    case "content_focus":
      return {
        id: "intake-content-focus",
        prompt: "What should I focus on?",
        suggestions: [
          "Best parts",
          "Most action",
          "Funny moments",
          "Emotional moments",
          "Use whole video continuously"
        ],
        kind: "single-choice"
      };
    case "duration":
      return {
        id: "intake-duration",
        prompt: "How long should it be?",
        suggestions: ["15 seconds", "30 seconds", "60 seconds", "Use best length"],
        kind: "single-choice"
      };
    case "format":
      return {
        id: "intake-format",
        prompt: "Where will you post it?",
        suggestions: [
          "YouTube Shorts / Reels / TikTok",
          "YouTube normal",
          "Square post"
        ],
        kind: "single-choice"
      };
    case "style":
      return {
        id: "intake-style",
        prompt: "What vibe do you want?",
        suggestions: [
          "Clean and simple",
          "Dark trailer",
          "Fast action",
          "Emotional",
          "Funny",
          "Luxury / premium",
          "Educational"
        ],
        kind: "single-choice"
      };
    case "text":
      return {
        id: "intake-text",
        prompt: "Do you want text on screen?",
        suggestions: ["No text", "Auto captions", "Use my custom lines"],
        kind: "single-choice"
      };
    case "audio":
      return {
        id: "intake-audio",
        prompt: "What should I do with audio?",
        suggestions: [
          "Keep original",
          "Lower original",
          "Mute",
          "Add music/SFX if supported"
        ],
        kind: "single-choice"
      };
    case "avoid":
      return {
        id: "intake-avoid",
        prompt: "Anything I should avoid or skip?",
        suggestions: ["Skip the intro", "Skip slow parts", "Nothing to avoid"],
        kind: "free-text"
      };
  }
}

/**
 * Decide the next question (or proceed). Asks at most ONE question — the
 * highest-priority missing high-impact field on the brief.
 */
export function decideQuestion(brief: EditBrief): QuestionDecision {
  const missing = brief.missing;
  if (missing.length === 0) {
    return { shouldAsk: false, missing };
  }
  for (const field of PRIORITY) {
    if (missing.includes(field)) {
      return { shouldAsk: true, question: buildQuestion(field), field, missing };
    }
  }
  // Defensive: a missing field not in PRIORITY — proceed rather than loop.
  return { shouldAsk: false, missing };
}

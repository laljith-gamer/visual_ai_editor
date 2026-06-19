// =====================================================================
// lib/analysis/purpose.ts
//
// Maps a user turn → AnalysisPurpose + PromptSpecificity. This is the
// bridge between WHAT the user asked and HOW MUCH local analysis we should
// spend (budget.ts). A human editor doesn't scan frames to "add the first
// 30 seconds", scans a few to "describe this", and scans coarse-then-deep to
// "find the red car".
//
// PURE. Reuses the existing pure classifiers (conversationIntent +
// videoPromptInterpreter) instead of a new phrase table — grammar-level, no
// genre table.
// =====================================================================

import { classifyConversationIntentSync, type ConversationContext } from "../intent/conversationIntent";
import { parseDuration, parseSourceScope, extractMeaningfulTopic } from "../intent/videoPromptInterpreter";
import type { AnalysisPurpose, PromptSpecificity } from "./types";

export interface PurposeContext {
  sourceCount: number;
  hasTimeline: boolean;
  pendingClarify?: boolean;
}

export interface PurposeResult {
  purpose: AnalysisPurpose;
  specificity: PromptSpecificity;
  /** A concrete content subject when one was stated (e.g. "red car"). */
  topic?: string;
  reason: string;
}

// Exact time / structural edits that need NO frame analysis.
const EXACT_RANGE =
  /\b(first|last|initial|final)\s+\d|\b\d{1,2}\s*[:.]\s*\d{2}\b|\bfrom\s+\d|\bkeep\s+\d|\bsplit\s+(?:at|the)|\bbetween\s+\d|\bseconds?\b\s+(?:to|-)\b/;
const MERGE_WHOLE =
  /\b(merge|combine|stitch|join|concat(?:enate)?)\b.*\b(all|every|whole|entire|videos|clips|them|together)\b|\bmerge all\b|\bjoin them\b/;
const CONTROL =
  /^\s*(render|export|download|save|undo|redo|play|pause|stop|preview|reset|clear)\b/;

// Transcript / spoken-content search.
const TRANSCRIPT_SEARCH =
  /\b(part|moment|bit|section|where|when)\b[\w\s'’]*\b(he|she|they|someone|guy|girl|host|speaker)?\s*(says?|said|talks?|mentions?|explains?)\b|\bwhere it says\b|\bquote\b|\btranscript\b|\bsubtitle\b|\bcaption(?:s)?\b/;

// Specific visual search — a concrete object/scene to locate.
const VISUAL_SEARCH_VERB =
  /\b(find|locate|search|look for|where('?s| is| are)|show me (?:the|where)|the (?:moment|part|scene|shot|clip) (?:of|with|where)|jump to|go to (?:the|where))\b/;

// Generic best-parts / reel vocabulary (NOT a genre table — output words).
const BEST_PARTS =
  /\b(best (?:parts?|moments?|bits?|picks?|clips?)|highlights?|montage|reel|short|recap|top moments?|greatest|funny (?:parts?|moments?)|action|cool (?:parts?|moments?))\b/;

// Cinematic / story styling (multi-video).
const STORY_STYLE =
  /\b(cinematic|story|storyline|narrative|trailer|emotional|journey|documentary)\b/;

function isVagueCreative(s: string): boolean {
  // "make this cool / good / nice / amazing / better" with no concrete subject.
  return /\b(make (?:this|it|something)|do something|make.*(?:cool|good|nice|amazing|epic|better|pop|great))\b/.test(s) &&
    !extractMeaningfulTopic(s);
}

/**
 * Classify a turn into an analysis purpose + specificity.
 * Conservative: when unsure, prefer the lighter scan, and let the
 * clarification policy ask before deeper work.
 */
export function classifyAnalysisPurpose(text: string, ctx: PurposeContext): PurposeResult {
  const s = (text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!s) {
    return { purpose: "none", specificity: "simple", reason: "empty turn" };
  }

  // 1) Read-only / control → no analysis. Use the shared conversation
  //    classifier so this stays consistent with the read-only lane.
  const convoCtx: ConversationContext = {
    hasTimeline: ctx.hasTimeline,
    clipCount: 0,
    hasPlan: false,
    hasSelectedClip: false,
    hasRenderedOutput: false,
    pendingClarify: Boolean(ctx.pendingClarify)
  };
  const convo = classifyConversationIntentSync(text, convoCtx);
  if (convo.kind === "read_only_meta" || convo.kind === "control_command") {
    return { purpose: "none", specificity: "exact", reason: "read-only / control — no frame analysis" };
  }
  if (convo.kind === "visual_question") {
    return { purpose: "quick_describe", specificity: "simple", reason: "describe request — a few keyframes" };
  }

  // 2) Exact structural edits → no analysis.
  if (CONTROL.test(s) || MERGE_WHOLE.test(s)) {
    return { purpose: "none", specificity: "exact", reason: "control / merge-whole — no frame analysis" };
  }
  if (EXACT_RANGE.test(s) && !BEST_PARTS.test(s)) {
    return { purpose: "none", specificity: "exact", reason: "explicit time range — no frame analysis" };
  }

  // 3) Transcript / spoken-content search.
  if (TRANSCRIPT_SEARCH.test(s)) {
    return { purpose: "transcript_search", specificity: "specific", reason: "spoken-content search — use the transcript, not vision" };
  }

  const topic = extractMeaningfulTopic(s) ?? undefined;
  const scope = parseSourceScope(s);
  const multiSource =
    ctx.sourceCount > 1 && (scope.type === "all" || scope.type === "selected" || scope.type === "explicit_sources");

  // 4) Multi-video cinematic / story.
  if (multiSource && (STORY_STYLE.test(s) || /\bfrom all\b|\ball (?:the )?videos\b/.test(s))) {
    return {
      purpose: "deep_story",
      specificity: STORY_STYLE.test(s) ? "normal" : "vague",
      topic,
      reason: "multi-video story/cinematic — summarize each source first"
    };
  }

  // 5) Specific visual search — a concrete subject to locate.
  if (VISUAL_SEARCH_VERB.test(s) && topic && !BEST_PARTS.test(s)) {
    return { purpose: "specific_visual_search", specificity: "specific", topic, reason: `visual search for "${topic}" — coarse then deep on candidates` };
  }

  // 6) Vague creative → light scan, but flag specificity so the
  //    clarification policy can ask for direction.
  if (isVagueCreative(s)) {
    return { purpose: "normal_highlights", specificity: "vague", reason: "vague creative request — light scan; may ask for direction" };
  }

  // 7) Best parts / highlights / reel (with or without a topic).
  if (BEST_PARTS.test(s) || convo.kind === "create_or_plan_edit") {
    const dur = parseDuration(s);
    return {
      purpose: "normal_highlights",
      specificity: topic ? "specific" : dur ? "normal" : "normal",
      topic,
      reason: topic ? `best-parts focused on "${topic}"` : "generic best-parts / reel"
    };
  }

  // 8) Anything else with a concrete subject → treat as a visual search-ish
  //    highlights run; otherwise default to a normal light scan.
  return {
    purpose: "normal_highlights",
    specificity: topic ? "specific" : "normal",
    topic,
    reason: topic ? `content focus "${topic}"` : "default highlights scan"
  };
}

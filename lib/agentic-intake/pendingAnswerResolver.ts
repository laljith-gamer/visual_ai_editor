// =====================================================================
// lib/agentic-intake/pendingAnswerResolver.ts
//
// Resolves free-text user replies against a pending ClarifyQuestion.
// This is what prevents the "What should I make?" infinite loop: when a
// question is pending, the user's NEXT message is first checked as an
// ANSWER to that question — using fuzzy matching, synonym expansion, and
// semantic inference from context.
//
// Priority order:
//   1. Exact chip match (case-insensitive).
//   2. Fuzzy/synonym deterministic match.
//   3. Contextual inference (the user's text resolves the field even if
//      phrased differently — e.g. "travel vlog best places" answers
//      "output_type" with "best_moments_reel" and provides content_focus).
//   4. LLM fallback (text-only, strict JSON) when enabled.
//   5. If still ambiguous, return null (caller can re-ask or proceed).
//
// PURE: no React, no store, no media. Unit-tested.
// =====================================================================

import type { ClarifyQuestion } from "@/lib/types";
import type { EditBrief, IntentKind, MissingField, OutputType } from "./editBrief";
import { normalizeEditingText } from "../intent/editingNormalize";

/** The resolved answer + which brief fields it fills. */
export interface ResolvedAnswer {
  /** The field this answer resolves (matches the question's target). */
  field: MissingField;
  /** How the answer was resolved. */
  method: "exact_chip" | "fuzzy" | "contextual" | "llm";
  /** The resolved value to merge into the brief. */
  patch: BriefPatch;
  /** Human-readable confirmation of what was understood. */
  summary: string;
  confidence: number;
}

/** A minimal, type-safe patch that can be merged into an EditBrief. */
export interface BriefPatch {
  intentKind?: IntentKind;
  sourceScope?: { type: string; reason?: string };
  output?: Partial<EditBrief["output"]>;
  content?: Partial<EditBrief["content"]>;
}

// ---- Output-type synonyms ------------------------------------------------

const OUTPUT_TYPE_MAP: Array<{ patterns: RegExp; outputType: OutputType; intentKind: IntentKind; label: string }> = [
  {
    patterns: /\b(one continuous|single (?:clip|short|take|segment)|continuous(?:ly)?|in one|as one|whole|uncut|straight through|one piece)\b/i,
    outputType: "single_continuous",
    intentKind: "continuous_clip",
    label: "one continuous short"
  },
  {
    patterns: /\b(best[- ]?(?:moments?|parts?|bits?|picks?)|highlights?|reel|best of|top moments?|greatest|best places?|best visits?|pick (?:the )?best)\b/i,
    outputType: "multi_clip",
    intentKind: "highlight_reel",
    label: "best-moments reel"
  },
  {
    patterns: /\b(specific (?:scene|moment|part)|the (?:part|moment|scene) (?:where|when)|find (?:the|a) (?:moment|scene|part))\b/i,
    outputType: "single_continuous",
    intentKind: "specific_moment",
    label: "specific scene"
  },
  {
    patterns: /\b(merge|combine|stitch|join|concat|as[- ]?is|back to back)\b/i,
    outputType: "as_is_merge",
    intentKind: "merge_sources",
    label: "merge as-is"
  }
];

// ---- Content-focus inference ------------------------------------------------

const CONTENT_TOPIC_RE = /\b(travel(?:ler)?|visit(?:s|ing)?|places?|locations?|spots?|scenes?|action|fight(?:ing|s)?|food|cooking|nature|sports?|gaming|vlog|music|dance|moments?)\b/gi;

function extractContentHints(text: string): string[] {
  const matches = text.match(CONTENT_TOPIC_RE);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.toLowerCase()))].slice(0, 5);
}

// ---- Source scope --------------------------------------------------------
// Generic English quantifiers / pointers only — NOT a genre/command table.
// Order matters: "selected" is the most specific, then "all", then "current".

const SELECTED_RE =
  /\b(selected|the ones i (?:picked|selected|ticked|chose)|ticked|the picked|chosen)\b/i;
const ALL_RE =
  /\b(all|both|everything|every ?one|every (?:video|clip)|all of (?:them|it)|all (?:the )?(?:videos?|clips?|uploaded)|uploaded (?:videos?|clips?)|whole library|the (?:two|three|four|2|3|4) videos?)\b/i;
const CURRENT_RE =
  /\b(current|this (?:video|clip|one)|active|just this|only this|the active)\b/i;

function inferScope(text: string): EditBrief["sourceScope"]["type"] | null {
  if (SELECTED_RE.test(text)) return "selected";
  if (ALL_RE.test(text)) return "all";
  if (CURRENT_RE.test(text)) return "current";
  return null;
}

// ---- Exact chip matching -------------------------------------------------

function matchExactChip(text: string, suggestions: string[]): string | null {
  const lower = text.toLowerCase().trim();
  for (const s of suggestions) {
    if (s.toLowerCase().trim() === lower) return s;
  }
  return null;
}

// ---- Fuzzy chip matching -------------------------------------------------

function matchFuzzyChip(text: string, suggestions: string[]): string | null {
  const lower = text.toLowerCase().trim().replace(/[^a-z0-9\s]/g, "");
  for (const s of suggestions) {
    const sl = s.toLowerCase().trim().replace(/[^a-z0-9\s]/g, "");
    // Contains the chip label or vice versa (within reason)
    if (lower.includes(sl) || sl.includes(lower)) return s;
    // Check if the significant words overlap (>= 60% of chip words)
    const chipWords = sl.split(/\s+/).filter((w) => w.length > 2);
    const userWords = new Set(lower.split(/\s+/));
    const overlap = chipWords.filter((w) => userWords.has(w)).length;
    if (chipWords.length > 0 && overlap / chipWords.length >= 0.6) return s;
  }
  return null;
}

// ---- Main resolver -------------------------------------------------------

export interface PendingQuestionContext {
  question: ClarifyQuestion;
  /** The field the pending question is asking about. */
  targetField: MissingField;
  /** Current partial brief (to avoid re-asking resolved fields). */
  currentBrief?: Partial<EditBrief>;
}

/**
 * Try to resolve the user's free-text as an answer to the pending question.
 * Returns null if the text doesn't seem to answer the question (caller can
 * then treat it as a new turn / topic change).
 */
export function resolvePendingAnswer(
  userText: string,
  ctx: PendingQuestionContext
): ResolvedAnswer | null {
  const { normalized } = normalizeEditingText(userText);
  const text = normalized || userText.toLowerCase();
  const { question, targetField } = ctx;

  // 1) Exact chip match
  const exact = matchExactChip(text, question.suggestions ?? []);
  if (exact) {
    const patch = chipToPatch(exact, targetField);
    if (patch) {
      return {
        field: targetField,
        method: "exact_chip",
        patch,
        summary: exact,
        confidence: 0.95
      };
    }
  }

  // 2) Fuzzy chip match
  const fuzzy = matchFuzzyChip(text, question.suggestions ?? []);
  if (fuzzy) {
    const patch = chipToPatch(fuzzy, targetField);
    if (patch) {
      return {
        field: targetField,
        method: "fuzzy",
        patch,
        summary: fuzzy,
        confidence: 0.8
      };
    }
  }

  // 3) Contextual inference — even if the user didn't pick a chip, their
  //    text may resolve the field semantically.
  const contextual = inferFieldFromText(text, targetField);
  if (contextual) return contextual;

  return null;
}

/** Convert a matched chip label to a brief patch for the target field. */
function chipToPatch(chip: string, field: MissingField): BriefPatch | null {
  const cl = chip.toLowerCase();
  switch (field) {
    case "output_type":
      if (/continuous|one/i.test(cl)) return { output: { outputType: "single_continuous" }, intentKind: "continuous_clip" };
      if (/best|reel|moment/i.test(cl)) return { output: { outputType: "multi_clip" }, intentKind: "highlight_reel" };
      if (/specific|scene/i.test(cl)) return { output: { outputType: "single_continuous" }, intentKind: "specific_moment" };
      if (/merge|as.?is/i.test(cl)) return { output: { outputType: "as_is_merge" }, intentKind: "merge_sources" };
      return null;
    case "content_focus":
      return { content: { focus: cl } };
    case "source_scope":
      if (/current/i.test(cl)) return { sourceScope: { type: "current", reason: "user chose current video" } };
      if (/selected/i.test(cl)) return { sourceScope: { type: "selected", reason: "user chose selected videos" } };
      if (/all/i.test(cl)) return { sourceScope: { type: "all", reason: "user chose all uploaded" } };
      return null;
    case "duration":
      const m = cl.match(/(\d+)\s*(s|sec|min)/);
      if (m) {
        const secs = m[2].startsWith("min") ? parseInt(m[1]) * 60 : parseInt(m[1]);
        return { output: { durationSeconds: secs } };
      }
      if (/best length|auto/i.test(cl)) return { output: { durationSeconds: undefined } };
      return null;
    default:
      return null;
  }
}

/** Infer a field's value from free text even when it doesn't match a chip. */
function inferFieldFromText(text: string, field: MissingField): ResolvedAnswer | null {
  switch (field) {
    case "output_type": {
      // Try output-type synonym patterns
      for (const entry of OUTPUT_TYPE_MAP) {
        if (entry.patterns.test(text)) {
          const contentHints = extractContentHints(text);
          const patch: BriefPatch = {
            output: { outputType: entry.outputType },
            intentKind: entry.intentKind,
            ...(contentHints.length > 0 ? { content: { focus: contentHints.join(", ") } } : {})
          };
          return {
            field: "output_type",
            method: "contextual",
            patch,
            summary: entry.label + (contentHints.length > 0 ? ` (${contentHints.join(", ")})` : ""),
            confidence: 0.75
          };
        }
      }
      // If text has content hints but no explicit output type, infer best-moments
      const hints = extractContentHints(text);
      if (hints.length > 0) {
        return {
          field: "output_type",
          method: "contextual",
          patch: {
            output: { outputType: "multi_clip" },
            intentKind: "highlight_reel",
            content: { focus: hints.join(", ") }
          },
          summary: `best-moments reel (${hints.join(", ")})`,
          confidence: 0.65
        };
      }
      return null;
    }
    case "content_focus": {
      const hints = extractContentHints(text);
      const scope = inferScope(text);
      if (hints.length > 0) {
        return {
          field: "content_focus",
          method: "contextual",
          patch: {
            content: { focus: hints.join(", ") },
            ...(scope ? { sourceScope: { type: scope, reason: "inferred from text" } } : {})
          },
          summary: hints.join(", "),
          confidence: 0.7
        };
      }
      return null;
    }
    case "source_scope": {
      const scope = inferScope(text);
      if (scope) {
        return {
          field: "source_scope",
          method: "contextual",
          patch: { sourceScope: { type: scope, reason: "inferred from text" } },
          summary: `${scope} video`,
          confidence: 0.7
        };
      }
      return null;
    }
    default:
      return null;
  }
}

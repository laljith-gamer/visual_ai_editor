/**
 * v1.7.5 — Intent shortcutting orchestrator.
 *
 * Single entry point. Takes the user's text + a snapshot of the
 * editor state and returns either:
 *   - a QuickMatch object describing the shortcut to dispatch, or
 *   - null, meaning the cloud planner should handle this turn.
 *
 * Threshold: 0.85. Below that we always fall through. Tuned strict
 * to favour false negatives (cloud handles them) over false positives
 * (which would silently misinterpret the user).
 *
 * Pattern precedence: when multiple patterns match (rare — e.g.,
 * "yes, merge them"), the highest-confidence match wins. Ties broken
 * by the priority order in PATTERN_ORDER.
 */

import { parse, isQuestion } from "./grammar";
import { matchProjectGrammar } from "./projectGrammar";
import { matchAffirm } from "./patterns/affirm";
import { matchCancel } from "./patterns/cancel";
import { matchEdit } from "./patterns/edit";
import { matchExtract } from "./patterns/extract";
import { matchMerge } from "./patterns/merge";
import { matchPromote } from "./patterns/promote";
import { matchTrimMerge } from "./patterns/trimMerge";
import type { QuickMatch, QuickMatchContext } from "./types";

/** Strict-by-default; the same value the proposal locked in. */
const CONFIDENCE_THRESHOLD = 0.85;

/** Tie-breaker order. The pattern at index 0 wins ties.
 *
 *  Reasoning:
 *    - Cancel + affirm are short-utterance gates; they should win over
 *      verb-and-object patterns when a pending action exists.
 *    - Promote should win over merge when a briefing is in scope and
 *      "those" / "the briefing" appears.
 *    - Merge / extract / edit fall through normal precedence. */
const PATTERN_ORDER: QuickMatch["kind"][] = [
  "cancel",
  "affirm",
  "promote",
  "edit",
  "extract",
  "merge"
];

export interface QuickMatchOptions {
  /** Override the default 0.85 threshold (e.g., for the dev tester). */
  threshold?: number;
  /** When true, returns the second-best candidate too — for debugging
   *  why a turn didn't match. Used by the dev tester page. */
  includeRunnerUp?: boolean;
}

export interface QuickMatchResult {
  match: QuickMatch | null;
  /** All candidates that returned non-null, sorted by confidence. The
   *  dev tester surfaces this list to help tune patterns. */
  candidates: QuickMatch[];
}

export function quickMatch(
  text: string,
  ctx: QuickMatchContext,
  opts: QuickMatchOptions = {}
): QuickMatchResult {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { match: null, candidates: [] };

  const parsed = parse(trimmed);

  // v1.7.11 — QUESTION GUARD. If the turn reads as a question / request
  // for information ("explain why they are the best parts", "what's in
  // clip 2?"), NEVER fire an action shortcut. Action matchers trigger on
  // keywords (e.g. "best parts" → promote), so a question containing
  // those words would otherwise silently mutate the timeline. We force
  // questions to fall through to the cloud planner, which can actually
  // answer them (describe / briefing). A missed shortcut costs one cloud
  // turn; a mis-fired action corrupts the user's timeline — so we bias
  // hard toward falling through here.
  if (isQuestion(parsed)) {
    return { match: null, candidates: [] };
  }

  // Build the candidate list. Each matcher returns null on no-match
  // so the array stays small.
  const candidates: QuickMatch[] = [];
  const tryAdd = (m: QuickMatch | null) => {
    if (m) candidates.push(m);
  };

  // Dynamic project grammar: compact synonym sets + slot parsers cover
  // hundreds of practical editor commands without 1000 hardcoded regexes.
  // It is still strict/high-confidence and falls through on ambiguity.
  tryAdd(matchProjectGrammar(parsed, ctx));

  tryAdd(matchAffirm(parsed, ctx));
  tryAdd(matchCancel(parsed, ctx));
  tryAdd(matchPromote(parsed, ctx));
  // v1.7.7 — multi-clause trim → per-source merge. Runs BEFORE the
  // single-clause matchers so a compound utterance like
  // "trim first 10 in V1, 5 in V2" produces one trimMerge match
  // (confidence 0.92) rather than the first clause being scooped up
  // by the extract pattern alone.
  tryAdd(matchTrimMerge(parsed, ctx));
  tryAdd(matchEdit(parsed, ctx));
  tryAdd(matchExtract(parsed, ctx));
  tryAdd(matchMerge(parsed, ctx));

  // Sort: highest confidence first, then PATTERN_ORDER for ties.
  candidates.sort((a, b) => {
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    return PATTERN_ORDER.indexOf(a.kind) - PATTERN_ORDER.indexOf(b.kind);
  });

  const threshold = opts.threshold ?? CONFIDENCE_THRESHOLD;
  const winner = candidates.find((c) => c.confidence >= threshold) ?? null;
  return { match: winner, candidates };
}

/** Convenience wrapper for callers that don't need the candidate list. */
export function quickMatchOne(
  text: string,
  ctx: QuickMatchContext,
  opts?: QuickMatchOptions
): QuickMatch | null {
  return quickMatch(text, ctx, opts).match;
}

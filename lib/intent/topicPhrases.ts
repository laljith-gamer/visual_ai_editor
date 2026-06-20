// =====================================================================
// lib/intent/topicPhrases.ts
//
// Preserve the user's CONTENT phrases instead of shattering them into a
// token soup. The old path turned "red boy and wukong fight" into
// "red and boy and wukong and fight" (every token a separate search term).
//
// This module groups RUNS of consecutive content (non-editing/meta) tokens
// into phrases, splitting only at real conjunctions/punctuation. So:
//   "red boy and wukong fight best combat scene" → ["red boy", "wukong fight", "combat"]
//
// It reuses the existing META_VOCAB (generic editing/output/scope words) so
// there is ONE definition of "not a content word". NO genre/entity table.
//
// PURE: imports META_VOCAB (a Set) + nothing else. Unit-tested.
// =====================================================================

import { META_VOCAB } from "./videoPromptInterpreter";

// A few control/scope words the interpreter's META_VOCAB doesn't include but
// which are never content subjects. Generic English, not topics.
const EXTRA_NON_TOPIC = new Set<string>([
  "only", "alone", "solely", "lemme", "gimme", "wanna", "gotta", "im",
  "id", "ive", "really", "actually", "maybe", "kinda",
  // generic control/scope words that are never a content subject
  "fit", "tofit", "needed", "unwanted", "extra", "rest", "remaining",
  "specific", "particular", "certain", "exact", "some", "any", "thing",
  // acquisition / search verbs (never a subject)
  "find", "finding", "search", "searching", "locate", "look", "looking",
  "want", "need", "give", "get", "show", "pick", "grab",
  // scope words (never a content subject)
  "current", "selected", "existing", "timeline"
]);

const NUMBER_WORDS = new Set<string>([
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "fifteen", "twenty", "thirty", "forty", "fifty",
  "sixty", "ninety"
]);

const ORDINALS = new Set<string>([
  "first", "second", "third", "fourth", "fifth", "sixth", "seventh",
  "1st", "2nd", "3rd", "4th", "5th", "last", "next"
]);

/** Tokens that end the current phrase and start a new group. */
const CONNECTOR = new Set<string>([
  "and", "&", "plus", "then", "also", "with", "or", "n"
]);

function isContentToken(tok: string): boolean {
  const w = tok.toLowerCase();
  if (w.length < 2) return false;
  if (/^\d/.test(w)) return false; // numbers / "30s"
  if (NUMBER_WORDS.has(w)) return false;
  if (ORDINALS.has(w)) return false;
  if (CONNECTOR.has(w)) return false;
  if (EXTRA_NON_TOPIC.has(w)) return false;
  if (META_VOCAB.has(w)) return false;
  return true;
}

export interface TopicPhrasesOptions {
  /** Max number of phrase groups returned. */
  maxPhrases?: number;
  /** Max words per phrase. */
  maxWordsPerPhrase?: number;
}

/**
 * Extract content-phrase GROUPS from text, preserving adjacency. A phrase is
 * a maximal run of consecutive content tokens; runs are separated by meta
 * words, connectors, or punctuation. Order-stable + de-duplicated.
 */
export function extractTopicPhrases(text: string, opts: TopicPhrasesOptions = {}): string[] {
  const maxPhrases = opts.maxPhrases ?? 6;
  const maxWords = opts.maxWordsPerPhrase ?? 5;

  // Split on whitespace AND punctuation that separates ideas (comma, slash,
  // semicolon, etc.) so "combat, dialogue" becomes two groups.
  const rawTokens = (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9'&/,-]/g, " ")
    .split(/(\s+|[,/;|])/)
    .map((t) => t.trim())
    .filter(Boolean);

  const phrases: string[] = [];
  const seen = new Set<string>();
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const phrase = current.slice(0, maxWords).join(" ");
    const key = phrase.toLowerCase();
    if (phrase && !seen.has(key)) {
      seen.add(key);
      phrases.push(phrase);
    }
    current = [];
  };

  for (const tok of rawTokens) {
    if (/^[,/;|]$/.test(tok)) {
      flush();
      continue;
    }
    if (isContentToken(tok)) {
      current.push(tok);
    } else {
      // A meta word / connector / number breaks the current phrase.
      flush();
    }
  }
  flush();

  return phrases.slice(0, maxPhrases);
}

/** Join phrases for a human-facing "Looking for …" line: "red boy / wukong fight / combat". */
export function joinTopicPhrasesForDisplay(phrases: string[]): string {
  return phrases.join(" / ");
}

/** True when the text contains at least one meaningful content phrase. */
export function hasContentTopic(text: string): boolean {
  return extractTopicPhrases(text).length > 0;
}

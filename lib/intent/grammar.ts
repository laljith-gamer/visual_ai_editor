/**
 * v1.7.5 — Thin compromise wrapper.
 *
 * Hides compromise's API behind small, typed helpers so the rest of
 * the intent module doesn't depend on compromise's surface directly.
 * If we ever swap to a different NLP library (e.g. winkNLP), only
 * this file changes.
 *
 * Footprint: importing compromise pulls in ~180 KB minified, but it's
 * tree-shaken so callers that only use a couple helpers don't pay for
 * unused features. The orchestrator (quickMatch.ts) is the only file
 * that actually parses every turn.
 */

import nlp from "compromise";

/** A parsed text snapshot. Created once per turn and threaded through
 *  every pattern matcher so we don't re-tokenize / re-tag. */
export interface ParsedText {
  raw: string;
  /** Lowercased trimmed text — used for fast string operations and
   *  case-insensitive substring checks. */
  lower: string;
  /** Whitespace-split tokens (lowercased). For O(1) "does this token
   *  appear" lookups via the `tokenSet` field. */
  tokens: string[];
  /** Token presence index. Built once per parse for cheap membership
   *  tests across multiple pattern matchers. */
  tokenSet: Set<string>;
  /** Compromise document handle. Use through the helpers below
   *  whenever possible — direct use leaks the nlp() API. */
  doc: ReturnType<typeof nlp>;
}

/** Build a ParsedText from raw user input. Empty / whitespace-only
 *  input returns a sentinel ParsedText whose helpers all return false
 *  / empty arrays — saves every caller a null check. */
export function parse(text: string): ParsedText {
  const trimmed = (text ?? "").trim();
  const lower = trimmed.toLowerCase();
  const tokens = lower.length > 0 ? lower.split(/\s+/).filter(Boolean) : [];
  return {
    raw: trimmed,
    lower,
    tokens,
    tokenSet: new Set(tokens),
    doc: nlp(trimmed)
  };
}

/** Negation detector.
 *
 *  Compromise has its own `.has("#Negative")` helper but it misses
 *  contractions like "don't" in some versions. We pair it with a
 *  conservative substring check on a tight token list. False positives
 *  here are FINE — they just make a pattern fall through to the cloud
 *  planner, which handles nuance better anyway.
 *
 *  Examples that should return true:
 *    "don't merge them"        → true
 *    "no editing, just merge"  → true (explicit "no editing")
 *    "never trim it"           → true
 *  Examples that should return false:
 *    "trim no more than 30s"   → false (stretches negation; we accept)
 *    "merge them"              → false
 */
export function hasNegation(p: ParsedText): boolean {
  if (p.lower.length === 0) return false;
  // Single-token / contraction matches that always count.
  const NEG_FRAGS = [
    "not ",
    "n't",
    " never",
    "never ",
    " no editing",
    " no edit",
    " no clipping",
    "don't",
    "do not",
    "didn't",
    "did not",
    "doesn't",
    "does not",
    "won't",
    "will not",
    "can't",
    "cannot",
    "shouldn't",
    "should not"
  ];
  for (const n of NEG_FRAGS) {
    if (p.lower.includes(n)) return true;
  }
  // Compromise's tag-based check as a backstop.
  try {
    if (p.doc.has("#Negative")) return true;
  } catch {
    /* compromise can throw on weird inputs — ignore */
  }
  return false;
}

/** True if any verb in the parsed text has one of the given lemmas
 *  (infinitive forms). Lemmatization handles "merging" / "joined" /
 *  "concatenated" → their base forms.
 *
 *  Note: compromise's `.toInfinitive()` is not perfect on irregular
 *  verbs but covers ~95% of common video-editing vocabulary. The
 *  remaining 5% can fall through to the cloud planner. */
export function hasVerbLemma(p: ParsedText, lemmas: string[]): boolean {
  if (p.lower.length === 0) return false;
  let infinitives: string[];
  try {
    infinitives = (p.doc.verbs().toInfinitive().out("array") as string[]).map(
      (v) => v.toLowerCase()
    );
  } catch {
    infinitives = [];
  }
  if (infinitives.length === 0) {
    // Compromise didn't tag any verbs — fall back to direct token
    // membership. Single-word imperatives ("merge them") sometimes
    // miss the verb tagger when there's no subject.
    const set = p.tokenSet;
    return lemmas.some((l) => set.has(l.toLowerCase()));
  }
  return lemmas.some((l) => infinitives.includes(l.toLowerCase()));
}

/** Fast token-presence check for nouns / pronouns / quantifiers. We
 *  don't run the full noun parser — just check whether ANY of the
 *  given words is present in the (lowercased) token set, accounting
 *  for trivial pluralisation. */
export function hasNoun(p: ParsedText, nouns: string[]): boolean {
  if (p.tokenSet.size === 0) return false;
  for (const n of nouns) {
    const lc = n.toLowerCase();
    if (p.tokenSet.has(lc)) return true;
    if (p.tokenSet.has(plural(lc))) return true;
    if (p.tokenSet.has(singular(lc))) return true;
  }
  return false;
}

/** True iff the literal phrase appears as a substring (case-insensitive,
 *  word-boundary-aware via simple whitespace padding). Good for multi-
 *  word triggers like "do it" / "as is" / "no edit". */
export function hasPhrase(p: ParsedText, phrases: string[]): boolean {
  // Pad with spaces so " do " doesn't match inside "doing" etc.
  const padded = ` ${p.lower} `;
  for (const ph of phrases) {
    if (padded.includes(` ${ph.toLowerCase()} `)) return true;
  }
  return false;
}

/** True if the input is short enough that single-token affirmations
 *  ("yes" / "go") are unambiguously commands and not part of a longer
 *  thought. Used by the affirm matcher to avoid firing on "yes I think
 *  we should...". */
export function isShortUtterance(p: ParsedText, maxTokens = 4): boolean {
  return p.tokens.length > 0 && p.tokens.length <= maxTokens;
}

// ---------------------------------------------------------------------
// Crude pluraliser — only handles English -s / -ies.
// Avoids a separate "pluralize" dep for what's a tiny lookup helper.
// ---------------------------------------------------------------------

function plural(n: string): string {
  if (n.endsWith("s")) return n;
  if (n.endsWith("y") && n.length > 1 && !/[aeiou]y$/.test(n)) {
    return n.slice(0, -1) + "ies";
  }
  return n + "s";
}

function singular(n: string): string {
  if (n.endsWith("ies")) return n.slice(0, -3) + "y";
  if (n.endsWith("s") && !n.endsWith("ss")) return n.slice(0, -1);
  return n;
}

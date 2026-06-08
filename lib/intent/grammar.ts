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

/**
 * True if the utterance reads as a QUESTION / request for information
 * rather than an imperative command.
 *
 * Why this exists: the action matchers (promote / edit / merge / extract)
 * trigger on KEYWORDS — e.g. "best parts" enables promote. But a question
 * like "explain why they are the best parts" contains that keyword while
 * asking for an explanation, NOT requesting a timeline mutation. Firing a
 * destructive shortcut on a question is the worst kind of false positive,
 * so the orchestrator uses this to force questions to fall through to the
 * cloud planner (which can actually answer via describe / briefing).
 *
 * Detection is deliberately broad (favouring "treat as question → fall
 * through") because a missed shortcut just costs one cloud turn, whereas a
 * mis-fired action silently changes the user's timeline.
 *
 * Returns true for:
 *   - text ending in "?"
 *   - leading WH-words / question auxiliaries ("why", "what", "how",
 *     "can you", "could you", "do they", "is this", "are these", …)
 *   - explicit ask verbs ("explain", "tell me", "describe", "why is")
 */
export function isQuestion(p: ParsedText): boolean {
  if (p.lower.length === 0) return false;

  // 1. Literal question mark anywhere.
  if (p.raw.includes("?")) return true;

  const lower = p.lower;
  const tokens = p.tokens.length > 0 ? p.tokens : lower.split(/\s+/);
  const first = tokens[0] ?? "";
  const second = tokens[1] ?? "";

  // 2. Leading interrogative / WH-word or question auxiliary. We compare
  //    the FIRST token fuzzily so common typos ("waht", "wht", "exaplain",
  //    "hwo") still classify as questions — keyword lists alone are too
  //    brittle for free-form chat input.
  const WH_WORDS = [
    "why", "what", "whats", "how", "when", "where", "which",
    "who", "whom", "whose", "why"
  ];
  const Q_AUX = [
    "can", "could", "would", "will", "should", "do", "does", "did",
    "is", "are", "was", "were", "am", "may", "might", "shall", "have", "has"
  ];
  const ASK_VERBS = [
    "explain", "describe", "clarify", "elaborate", "summarize",
    "summarise", "list", "show", "tell"
  ];

  // Imperative look-alikes we must NOT treat as questions.
  const IMPERATIVE_EXCEPTION = /^(?:do\s+it|do\s+that|will\s+do|can\s+do)\b/;

  if (WH_WORDS.includes(first)) return true;

  if (Q_AUX.includes(first) && !IMPERATIVE_EXCEPTION.test(lower)) {
    return true;
  }

  // Fuzzy first-token check for the DISTINCT WH-words only (those with no
  // common command homograph), so typos like "waht"/"wht"/"wher" still
  // read as questions. "how" is excluded here because "show" is one
  // transposition away from it — we require "how" to be exact to avoid
  // misclassifying "show the best parts" as a question.
  const FUZZY_WH = ["what", "whats", "why", "where", "when", "which", "whom", "whose"];
  if (matchesAnyFuzzy(first, FUZZY_WH)) return true;

  // 3. "Ask for information" verbs near the start. Pure ask-verbs
  //    ("explain"/"describe"/...) are questions on their own. Ambiguous
  //    verbs ("tell"/"show"/"list") only count when followed by "me"/"us"
  //    or a WH-word, so imperatives ("show the best parts") stay commands.
  for (let i = 0; i < Math.min(2, tokens.length); i++) {
    const tok = tokens[i];
    if (matchesAnyFuzzy(tok, ["explain", "describe", "clarify", "elaborate"])) {
      return true;
    }
    if (tok === "tell" || tok === "show" || tok === "list" || tok === "summarize" || tok === "summarise") {
      const next = tokens[i + 1] ?? "";
      if (next === "me" || next === "us" || matchesAnyFuzzy(next, WH_WORDS)) {
        return true;
      }
    }
  }
  void second;
  void ASK_VERBS;

  return false;
}

/**
 * Token-level fuzzy match: true if `token` equals any candidate OR is a
 * near-miss typo of one (edit distance ≤ 1 for short words, ≤ 2 for
 * longer ones). This is what makes question detection robust to the kind
 * of misspellings real users type ("exaplain", "waht", "hwo") instead of
 * relying on an exhaustive keyword list.
 */
function matchesAnyFuzzy(token: string, candidates: string[]): boolean {
  if (!token) return false;
  for (const c of candidates) {
    if (token === c) return true;
    // Only bother with distance for words of comparable length.
    if (Math.abs(token.length - c.length) > 2) continue;
    const budget = c.length <= 4 ? 1 : 2;
    if (withinEditDistance(token, c, budget)) return true;
  }
  return false;
}

/** Bounded Damerau-Levenshtein: true if edits(a,b) <= max, counting an
 *  adjacent transposition (a common typing error like "waht"→"what",
 *  "hwo"→"how") as a SINGLE edit. Early-exits when the running minimum
 *  exceeds `max`, so it stays cheap for the short words we test. */
function withinEditDistance(a: string, b: string, max: number): boolean {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return false;

  // d[i][j] = distance between a[0..i) and b[0..j)
  const d: number[][] = Array.from({ length: la + 1 }, () =>
    new Array<number>(lb + 1).fill(0)
  );
  for (let i = 0; i <= la; i++) d[i][0] = i;
  for (let j = 0; j <= lb; j++) d[0][j] = j;

  for (let i = 1; i <= la; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(
        d[i - 1][j] + 1, // deletion
        d[i][j - 1] + 1, // insertion
        d[i - 1][j - 1] + cost // substitution
      );
      // Transposition of two adjacent characters.
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        v = Math.min(v, d[i - 2][j - 2] + 1);
      }
      d[i][j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return false;
  }
  return d[la][lb] <= max;
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

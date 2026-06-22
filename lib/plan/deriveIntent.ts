// =====================================================================
// lib/plan/deriveIntent.ts
//
// Deterministic "actionable intent" interpreter — a SAFETY NET, not the
// primary path.
//
// The cloud planner LLM remains the primary interpreter of user intent
// (see lib/plan/prompt.ts). This helper exists to (a) break the legacy
// dead-end where a short, imperfect-but-clear request such as
// "i need a ingredient part alone for 1min" used to return a static
// "what should the short be about?" clarify, and (b) keep the turn alive
// when the cloud planner is unreachable (504/503/timeout) — see the
// catch path in app/api/agent/route.ts.
//
// It reads: duration, a content-focus phrase (typo-normalized), exclusivity
// ("only"/"alone"/"just"), an output format, and produces CLEAN scenario
// labels for display (never the user's raw broken text). It never invents
// domain knowledge (e.g. cooking-specific exclusions) — that nuance is the
// LLM's job; here we only derive generic, honest constraints.
//
// Dependency-light on purpose. The only import is the PURE editing-typo
// normalizer (which reads pure config) so search typos like "combact" →
// "combat" are fixed before tokenization. Unit-tested with `node --test`.
// =====================================================================

import { normalizeEditingText } from "../intent/editingNormalize";

/** Mirrors PLAN_BOUNDS.targetShortSeconds in lib/config.ts. Kept inline so
 *  this module stays import-free and testable. */
const DURATION_BOUNDS = { min: 5, max: 600 } as const;

export interface ActionableIntent {
  /** True when there's enough to act WITHOUT asking the user for a topic. */
  actionable: boolean;
  /** Display focus phrase, e.g. "ingredient-only moments" /
   *  "cooking and ingredient moments". */
  focus: string | null;
  /** Core subject words only, typo-normalized, e.g. "ingredient" /
   *  "cooking ingredient". */
  rawFocus: string | null;
  /** Clean, display-ready scenario labels (one per subject). Used both as
   *  the "Looking for" rows and as the SigLIP scenario prompts — so the UI
   *  never shows the user's raw, broken text. */
  scenarioLabels: string[];
  /** Parsed target duration in seconds, when the user stated one. */
  targetSeconds: number | null;
  /** True only when the user explicitly stated a duration. */
  userSpecifiedDuration: boolean;
  /** True when the user limited scope ("only" / "alone" / "just"). */
  exclusiveOnly: boolean;
  /** True when the request is a GENERIC "best parts / highlights / make a
   *  reel" ask with no concrete subject left after removing editing/output
   *  vocabulary. The pipeline should score for broad VISUAL INTEREST
   *  (motion + saliency), NOT run SigLIP against meaningless words like
   *  "best" or "picks". See issue #62. This is NOT a genre table — it is
   *  generic editing/output vocabulary cleanup only. */
  genericBestParts: boolean;
  /** Generic, honest exclusion constraints derived from exclusivity. */
  negativeConstraints: string[];
  /** Output framing. Defaults to "vertical" (this is a shorts app). */
  format: "vertical" | "horizontal" | "square";
  /** True when fulfilling this intent requires the vision/scoring pipeline. */
  needsAnalysis: boolean;
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, ninety: 90
};

// Token-level typo / spelling normalization. Generic, high-frequency fixes
// only — NOT a genre/keyword table for branching. Applied per word after
// tokenization so "ingrdient" is understood as "ingredient".
const TYPO_FIXES: Record<string, string> = {
  ingrdient: "ingredient",
  ingrediant: "ingredient",
  ingradient: "ingredient",
  ingredent: "ingredient",
  ingedient: "ingredient",
  ingridient: "ingredient",
  ingredients: "ingredient",
  ingrdients: "ingredient",
  ingrediants: "ingredient"
};

// Command / filler / person / connective tokens stripped when deriving the
// content focus. These are generic English words (verbs of looking, pronouns,
// articles, units) — NOT a genre/subject table.
const STOPWORDS = new Set([
  // pronouns / persons
  "i", "we", "you", "he", "she", "they", "him", "her", "his", "hers",
  "their", "theirs", "them", "it", "its", "me", "my", "mine", "our", "your",
  // verbs of looking / capturing / making
  "see", "seeing", "watch", "watching", "look", "looking", "view", "viewing",
  "catch", "catching", "capture", "capturing", "detect", "detecting",
  "identify", "identifying", "find", "finding", "show", "showing", "get",
  "getting", "make", "making", "made", "create", "creating", "build",
  "building", "give", "giving", "do", "doing", "cut", "cutting", "edit",
  "editing", "grab", "grabbing", "keep", "keeping", "want", "wanting",
  "wanna", "need", "needing", "would", "like", "please", "pls", "plz",
  "can", "could", "lemme", "let",
  // question / connective words
  "what", "whats", "which", "where", "when", "who", "how", "that", "this",
  "these", "those", "and", "or", "of", "to", "for", "with", "from", "into",
  "in", "on", "at", "about", "around", "the", "a", "an", "is", "are", "be",
  "am", "was", "were", "some", "any", "just", "only", "alone", "solely",
  // editing / output nouns that aren't a subject
  "part", "parts", "section", "sections", "segment", "segments", "bit",
  "bits", "piece", "pieces", "clip", "clips", "shot", "shots", "scene",
  "scenes", "moment", "moments", "video", "vid", "footage", "film", "movie",
  "short", "shorts", "reel", "reels", "version", "thing", "things", "stuff",
  // duration units (numerics handled separately)
  "sec", "secs", "second", "seconds", "min", "mins", "minute", "minutes",
  "duration", "length", "hour", "hours", "hr", "hrs",
  // v1.8.1 — multi-source / compose words must never become a subject
  // label. (Compose is detected upstream by deriveComposeIntent; these are
  // a belt-and-braces guard so even a stray fall-through can't produce
  // "pick / first / transition moments".)
  "pick", "picking", "picked", "first", "second", "third", "fourth", "fifth",
  "upload", "uploads", "uploaded", "transition", "transitions", "merge",
  "combine", "mix", "shuffle", "montage", "another"
]);

// Generic editing / output-quality vocabulary. These words survive the
// STOPWORDS pass (they aren't pronouns/verbs/articles) but they are NOT
// content SUBJECTS — they describe "give me the good bits", not a topic. If
// the ONLY tokens left after stopword removal are these, the request is a
// generic best-parts / highlights ask and must score for broad visual
// interest, not literal SigLIP search for "best"/"picks". (Issue #62.)
//
// This is deliberately a small, domain-AGNOSTIC list of editorial-quality
// words — NOT a genre/subject keyword table. Do not add topics here.
const GENERIC_EDIT_VOCAB = new Set([
  "best", "bests", "top", "key", "greatest", "finest", "favourite",
  "favorite", "favourites", "favorites", "picks", "pic", "pics",
  "highlight", "highlights", "standout", "standouts", "memorable",
  "interesting", "exciting", "epic", "cool", "awesome", "good", "great",
  "nice", "fun", "montage", "compilation", "compile", "recap", "summary",
  "overview", "wrapup", "wrap", "bestof"
]);

// Output / format words that signal a short-form reel is wanted. These are
// already stripped as STOPWORDS from the subject tokens, so we detect them
// from the raw text instead. Used only to decide that a duration-bearing
// request like "make a 40 sec reel" is a generic best-parts ask.
const REEL_OUTPUT_RE =
  /\b(reels?|shorts?|montages?|compilations?|recaps?|highlights?|tiktoks?|story|stories)\b/;

/** Parse a duration in seconds from free text. Returns null when none stated. */
function parseDuration(text: string): number | null {
  const t = text.toLowerCase();

  // mm:ss (e.g. "1:30")
  const clock = t.match(/\b(\d{1,2}):(\d{2})\b/);
  if (clock) {
    const secs = parseInt(clock[1], 10) * 60 + parseInt(clock[2], 10);
    if (secs > 0) return clampDuration(secs);
  }

  // "<n> min(s)/minute(s)/m"  (e.g. "1min", "1 min", "2 minutes")
  const mins = t.match(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/);
  if (mins) {
    const secs = Math.round(parseFloat(mins[1]) * 60);
    if (secs > 0) return clampDuration(secs);
  }

  // "<n> sec(s)/second(s)/s"  (e.g. "30 sec", "45s")
  const secsMatch = t.match(/(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/);
  if (secsMatch) {
    const secs = Math.round(parseFloat(secsMatch[1]));
    if (secs > 0) return clampDuration(secs);
  }

  // word-number + unit (e.g. "one minute", "thirty seconds")
  const word = t.match(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|sixty|ninety)\s*(minutes?|mins?|seconds?|secs?)\b/
  );
  if (word) {
    const n = WORD_NUMBERS[word[1]] ?? 0;
    const isMinutes = /^min/.test(word[2]);
    const secs = isMinutes ? n * 60 : n;
    if (secs > 0) return clampDuration(secs);
  }

  return null;
}

function clampDuration(secs: number): number {
  return Math.min(DURATION_BOUNDS.max, Math.max(DURATION_BOUNDS.min, Math.round(secs)));
}

function detectFormat(text: string): ActionableIntent["format"] {
  const t = text.toLowerCase();
  if (/\b(horizontal|landscape|widescreen|16:9)\b/.test(t)) return "horizontal";
  if (/\b(square|1:1)\b/.test(t)) return "square";
  // Default to vertical: this is a shorts app, and reel/short/tiktok/story
  // phrasing (or no framing at all) all imply a vertical short.
  return "vertical";
}

/**
 * Derive an actionable intent from imperfect user text.
 *
 * @param userText  the user's verbatim request
 * @param _ctx      optional context (reserved for future grounding via
 *                  briefing/transcript hints)
 */
export function deriveActionableIntent(
  userText: string,
  _ctx: { hasVideo?: boolean } = {}
): ActionableIntent {
  const text = (userText || "").trim();
  // Fix obvious editing-vocabulary typos first ("combact" → "combat",
  // "cutsecene" → "cutscene") so they don't survive as broken subject
  // tokens. Real content subjects are preserved (see editingNormalize).
  const lower = normalizeEditingText(text).normalized;

  const targetSeconds = parseDuration(text);
  const format = detectFormat(text);
  // Exclusivity: "only/just/alone/solely/nothing but" AND the common
  // "ignore everything else" / "nothing else" framing. All of these mean the
  // named subject is the WHOLE edit → its include constraints become HARD.
  const exclusiveOnly =
    /\b(only|alone|just|solely|nothing but)\b/.test(lower) ||
    /\b(ignore|skip|drop|remove|cut)\s+(everything|all|the rest|anything)\s*(else)?\b/.test(lower) ||
    /\b(nothing|no)\s+(else|other)\b/.test(lower) ||
    /\beverything\s+else\b/.test(lower);

  // Tokenize: strip clock + number+unit tokens, keep words, then drop generic
  // command/filler words and normalize per-word typos.
  const stripped = lower
    .replace(/\b\d{1,2}:\d{2}\b/g, " ")
    .replace(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m|seconds?|secs?|s)\b/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ");

  const seen = new Set<string>();
  const coreTokens: string[] = [];
  for (const rawWord of stripped.split(/\s+/)) {
    const w0 = rawWord.trim();
    if (!w0) continue;
    const w = TYPO_FIXES[w0] ?? w0;
    if (w.length < 2) continue;
    if (STOPWORDS.has(w) || w in WORD_NUMBERS) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    coreTokens.push(w);
  }

  // Issue #62 — generic best-parts detection. Separate genuine SUBJECT tokens
  // from generic editing/output vocabulary. If nothing concrete remains, the
  // request is a generic "best parts / highlights / make a reel" ask: it must
  // NOT turn "best"/"picks" into literal SigLIP search subjects.
  const subjectTokens = coreTokens.filter((w) => !GENERIC_EDIT_VOCAB.has(w));
  const hasGenericEditWord = coreTokens.some((w) => GENERIC_EDIT_VOCAB.has(w));
  const wantsReelOutput = REEL_OUTPUT_RE.test(lower);
  const genericBestParts =
    subjectTokens.length === 0 &&
    (hasGenericEditWord || (targetSeconds !== null && wantsReelOutput));

  // Build clean, display-ready scenario labels + a focus phrase. We NEVER
  // surface the user's raw text here.
  let focus: string | null = null;
  const scenarioLabels: string[] = [];

  if (genericBestParts) {
    // Generic visual-interest output. The pipeline scores motion + saliency
    // (semantic = 0); the scenario label is for DISPLAY only. No subject words.
    focus = "best moments";
    scenarioLabels.push("visually rich moments");
  } else if (subjectTokens.length > 0) {
    if (exclusiveOnly) {
      const joined = subjectTokens.join(" ");
      focus = `${joined}-only moments`;
      scenarioLabels.push(`${joined}-only moments`);
    } else if (subjectTokens.length === 1) {
      focus = `${subjectTokens[0]} moments`;
      scenarioLabels.push(`${subjectTokens[0]} moments`);
    } else {
      focus = `${subjectTokens.join(" and ")} moments`;
      for (const t of subjectTokens) scenarioLabels.push(`${t} moments`);
    }
  }

  // For a generic best-parts ask the display "raw focus" is the editing
  // intent, not a search subject. For a concrete subject it is the cleaned
  // subject tokens (used as semantic grounding downstream).
  const effectiveRawFocus = genericBestParts
    ? "visual interest"
    : subjectTokens.length > 0
      ? subjectTokens.join(" ").slice(0, 80)
      : null;

  const negativeConstraints: string[] = [];
  if (exclusiveOnly && effectiveRawFocus && !genericBestParts) {
    negativeConstraints.push(`keep only the ${effectiveRawFocus} segments`);
    negativeConstraints.push("exclude unrelated scenes");
  }

  // Actionable when we have a concrete subject, a generic best-parts ask, OR a
  // stated duration paired with an explicit "only/alone" scope.
  const actionable =
    genericBestParts ||
    Boolean(effectiveRawFocus) ||
    (targetSeconds !== null && exclusiveOnly);

  return {
    actionable,
    focus,
    rawFocus: effectiveRawFocus,
    scenarioLabels,
    targetSeconds,
    userSpecifiedDuration: targetSeconds !== null,
    exclusiveOnly,
    genericBestParts,
    negativeConstraints,
    format,
    needsAnalysis: actionable
  };
}

/**
 * Build a short, dynamic, context-aware assistant message for an actionable
 * intent. When no video/source exists we ask only for an upload (never for
 * the topic). Otherwise we confirm the action and proceed.
 */
export function actionableIntentMessage(
  intent: ActionableIntent,
  hasVideo: boolean
): string {
  const focus = intent.focus ?? "the best moments";
  const dur = intent.targetSeconds ? `${intent.targetSeconds}s` : "";
  const shortLabel = dur ? `${dur} short` : "short";

  if (!hasVideo) {
    return `Upload the video first, then I\u2019ll find the ${focus} and make a ${shortLabel}.`;
  }

  let msg = `Got it \u2014 I\u2019ll look for ${focus} and build a ${shortLabel}.`;
  if (intent.exclusiveOnly && intent.rawFocus) {
    msg += ` I\u2019ll keep only the ${intent.rawFocus} parts and skip unrelated scenes.`;
  }
  return msg;
}

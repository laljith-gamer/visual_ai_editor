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
// Dependency-free on purpose (no "@/..." imports) so it can be unit-tested
// directly with `node --test --experimental-strip-types`.
// =====================================================================

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
  "sec", "secs", "second", "seconds", "min", "mins", "minute", "minutes"
]);

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
  const lower = text.toLowerCase();

  const targetSeconds = parseDuration(text);
  const format = detectFormat(text);
  const exclusiveOnly = /\b(only|alone|just|solely|nothing but)\b/.test(lower);

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

  const rawFocus = coreTokens.length > 0 ? coreTokens.join(" ").slice(0, 80) : null;

  // Build clean, display-ready scenario labels + a focus phrase. We NEVER
  // surface the user's raw text here.
  let focus: string | null = null;
  const scenarioLabels: string[] = [];
  if (coreTokens.length > 0) {
    if (exclusiveOnly) {
      const joined = coreTokens.join(" ");
      focus = `${joined}-only moments`;
      scenarioLabels.push(`${joined}-only moments`);
    } else if (coreTokens.length === 1) {
      focus = `${coreTokens[0]} moments`;
      scenarioLabels.push(`${coreTokens[0]} moments`);
    } else {
      focus = `${coreTokens.join(" and ")} moments`;
      for (const t of coreTokens) scenarioLabels.push(`${t} moments`);
    }
  }

  const negativeConstraints: string[] = [];
  if (exclusiveOnly && rawFocus) {
    negativeConstraints.push(`keep only the ${rawFocus} segments`);
    negativeConstraints.push("exclude unrelated scenes");
  }

  // Actionable when we have a content focus, OR a stated duration paired with
  // an explicit "only/alone" scope (enough to build a visual-interest cut).
  const actionable = Boolean(rawFocus) || (targetSeconds !== null && exclusiveOnly);

  return {
    actionable,
    focus,
    rawFocus,
    scenarioLabels,
    targetSeconds,
    userSpecifiedDuration: targetSeconds !== null,
    exclusiveOnly,
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

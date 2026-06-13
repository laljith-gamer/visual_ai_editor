// =====================================================================
// lib/plan/deriveIntent.ts
//
// Deterministic "actionable intent" interpreter — a SAFETY NET, not the
// primary path.
//
// The cloud planner LLM remains the primary interpreter of user intent
// (see lib/plan/prompt.ts). This helper exists ONLY to break the legacy
// dead-end where a short, imperfect-but-clear request such as
// "i need a ingredient part alone for 1min" used to return the static
// clarify "what should the short be about?". When the LLM path fails to
// produce a usable plan, the agent route consults this helper so the
// assistant can still PROCEED (or, at worst, ask a context-aware question)
// instead of re-asking for a topic the user already gave.
//
// It is intentionally light: it reads duration, a content-focus phrase,
// exclusivity ("only"/"alone"/"just") and an output format hint. It never
// invents domain knowledge (e.g. cooking-specific exclusions) — that
// nuance is the LLM's job; here we only derive generic, honest constraints.
// =====================================================================

import { PLAN_BOUNDS } from "@/lib/config";

export interface ActionableIntent {
  /** True when there's enough to act WITHOUT asking the user for a topic. */
  actionable: boolean;
  /** Display focus phrase, e.g. "ingredient-only moments" / "funny moments". */
  focus: string | null;
  /** Core subject words only, e.g. "ingredient" / "intro" / "funny".
   *  Used as the SigLIP scenario prompt. */
  rawFocus: string | null;
  /** Parsed target duration in seconds, when the user stated one. */
  targetSeconds: number | null;
  /** True only when the user explicitly stated a duration. */
  userSpecifiedDuration: boolean;
  /** True when the user limited scope ("only" / "alone" / "just"). */
  exclusiveOnly: boolean;
  /** Generic, honest exclusion constraints derived from exclusivity. */
  negativeConstraints: string[];
  /** Output framing when stated/implied ("reel"/"short"/"tiktok" → vertical). */
  format: "vertical" | "horizontal" | "square" | null;
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40,
  forty5: 45, fifty: 50, sixty: 60, ninety: 90
};

// Command/filler tokens stripped when deriving the content focus. These are
// generic English connective/command words — NOT a genre/keyword table.
const STOPWORDS = new Set([
  "i", "we", "you", "need", "want", "wanna", "would", "like", "make", "made",
  "create", "build", "give", "get", "show", "find", "do", "please", "can",
  "could", "pls", "plz", "a", "an", "the", "for", "of", "to", "with", "and",
  "me", "my", "it", "this", "that", "these", "those", "is", "are", "be",
  "some", "any", "part", "parts", "section", "sections", "segment", "segments",
  "bit", "bits", "piece", "pieces", "clip", "clips", "video", "footage",
  "short", "shorts", "reel", "reels", "edit", "cut", "version", "into",
  "from", "out", "where", "only", "alone", "just", "solely", "around",
  "about", "sec", "secs", "second", "seconds", "min", "mins", "minute",
  "minutes"
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
  const { min, max } = PLAN_BOUNDS.targetShortSeconds;
  return Math.min(max, Math.max(min, Math.round(secs)));
}

function detectFormat(text: string): ActionableIntent["format"] {
  const t = text.toLowerCase();
  if (/\b(vertical|reels?|shorts?|tiktok|tik tok|stor(y|ies)|portrait)\b/.test(t)) {
    return "vertical";
  }
  if (/\b(horizontal|landscape|widescreen|16:9)\b/.test(t)) return "horizontal";
  if (/\b(square|1:1)\b/.test(t)) return "square";
  return null;
}

/**
 * Derive an actionable intent from imperfect user text.
 *
 * @param userText  the user's verbatim request
 * @param ctx       optional context (currently unused fields reserved for
 *                  future grounding via briefing/transcript hints)
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

  // Derive a content-focus phrase: strip clock/number+unit tokens, then drop
  // generic command/filler words. Whatever meaningful subject remains is the
  // focus (e.g. "ingredient", "intro", "funny").
  const stripped = lower
    .replace(/\b\d{1,2}:\d{2}\b/g, " ")
    .replace(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m|seconds?|secs?|s)\b/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ");

  const coreTokens = stripped
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0 && !STOPWORDS.has(w) && !(w in WORD_NUMBERS));

  const rawFocus = coreTokens.length > 0 ? coreTokens.join(" ").slice(0, 80) : null;

  let focus: string | null = null;
  if (rawFocus) {
    focus = exclusiveOnly ? `${rawFocus}-only moments` : `${rawFocus} moments`;
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
    targetSeconds,
    userSpecifiedDuration: targetSeconds !== null,
    exclusiveOnly,
    negativeConstraints,
    format
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

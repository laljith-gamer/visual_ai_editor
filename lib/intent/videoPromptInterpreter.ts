// =====================================================================
// lib/intent/videoPromptInterpreter.ts
//
// Professional VIDEO-PROMPT INTERPRETER (issue #64).
//
// Messy, real-user editing prompts cross the boundaries of the specialized
// detectors (composeIntent / deriveActionableIntent / fastCommands / …).
// Before any of those try to assign meaning, this module extracts the
// structured "slots" a human editor would hear:
//
//   - normalized text (spelling/spacing cleanup only — never a topic table)
//   - duration                ("5 min" → 300, "40 sec" → 40, "1:30" → 90)
//   - clip count              ("at least 5 clips" → minClipCount 5)
//   - format / aspect         (vertical / horizontal / square)
//   - platform                (youtube_shorts / instagram_reels / tiktok)
//   - source scope            ("from all videos" → all)
//   - a MEANINGFUL content topic, with meta/editing words stripped so
//     "atleast sect all" / "min vertical" can NEVER become a search subject.
//
// The whole point (issue #64): meta/output words must not become topics.
//
// Pure + import-light: only `import type` from @/lib/types (stripped by the
// Node test runner) and value config from a RELATIVE path (resolved by the
// test runner's ts-ext hook). Unit-testable with `node --test`.
// =====================================================================

import { VIDEO_PROMPT } from "../config";

export type PromptFormat = "vertical" | "horizontal" | "square";
export type PromptPlatform =
  | "youtube_shorts"
  | "instagram_reels"
  | "tiktok"
  | "generic";

export interface NormalizedPrompt {
  normalized: string;
  original: string;
  /** Human-readable list of what normalization changed (debug/UX). */
  evidence: string[];
}

export interface ClipCountSlots {
  minClipCount?: number;
  maxClipCount?: number;
  targetClipCount?: number;
}

export interface SourceScopeSlot {
  type: "active" | "selected" | "all" | "explicit_sources" | "ambiguous";
  sourceRefs?: Array<{ type: "index" | "name"; index?: number; name?: string }>;
  reason: string;
}

// ---------------------------------------------------------------------
// Number words (shared by every parser).
// ---------------------------------------------------------------------
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90
};

function wordToNum(token: string): number | null {
  if (/^\d+(?:\.\d+)?$/.test(token)) {
    const n = Number(token);
    return Number.isFinite(n) ? n : null;
  }
  return NUMBER_WORDS[token] ?? null;
}

const NUMBER_ALT = `\\d+(?:\\.\\d+)?|${Object.keys(NUMBER_WORDS).join("|")}`;

// =====================================================================
// META VOCABULARY — generic editing / output / source / quality words that
// must NOT, by themselves, become a content topic. This is grammar/editing
// vocabulary cleanup, NOT a genre table (no "cooking"/"gaming"/etc.).
// =====================================================================
export const META_VOCAB = new Set<string>([
  // selection / acquisition verbs
  "select", "selct", "sect", "pick", "picks", "picking", "picked", "take",
  "taking", "get", "getting", "grab", "grabbing", "use", "using", "used",
  "include", "including", "choose", "choosing", "want", "wanting", "need",
  "needing", "show", "showing", "give", "giving",
  // build / produce verbs
  "make", "making", "made", "build", "building", "create", "creating",
  "generate", "generating", "produce", "producing", "do", "doing", "turn",
  "convert", "render", "export",
  // timeline-edit verbs (never a subject)
  "trim", "trimming", "trimmed", "remove", "removing", "removed", "delete",
  "deleting", "drop", "dropping", "split", "splitting", "move", "moving",
  "add", "adding", "replace", "replacing", "reorder", "reverse", "speed",
  // exclusion vocabulary (handled by the exclusion parser, never a subject)
  "avoid", "avoiding", "without", "except", "excluding", "exclude", "skip",
  "skipping", "ignore", "ignoring", "but", "dont", "doesnt", "not", "none",
  // combine / arrange
  "combine", "combined", "combining", "merge", "merging", "merged", "mix",
  "mixing", "montage", "join", "joining", "stitch", "stitching", "compile",
  "compilation", "interleave", "interleaved", "alternate", "alternating",
  "shuffle", "shuffled", "shuffling", "order", "ordering", "arrange",
  // scope
  "all", "every", "each", "whole", "full", "entire", "both", "them",
  // units / pieces (NOT subjects)
  "clip", "clips", "section", "sections", "segment", "segments", "part",
  "parts", "cut", "cuts", "piece", "pieces", "shot", "shots", "scene",
  "scenes", "moment", "moments", "bit", "bits", "frame", "frames",
  // source nouns
  "video", "videos", "vid", "vids", "vedio", "vidio", "upload", "uploads",
  "uploaded", "source", "sources", "file", "files", "footage", "film",
  "movie", "another", "other",
  // count qualifiers
  "at", "least", "atleast", "minimum", "min", "mins", "maximum", "max",
  "atmost", "around", "about", "approximately", "roughly", "more", "less",
  "than", "upto", "no",
  // duration units
  "second", "seconds", "sec", "secs", "minute", "minutes", "hour", "hours",
  "hr", "hrs", "long",
  // format / aspect / platform
  "vertical", "verticle", "horizontal", "square", "portrait", "landscape",
  "widescreen", "reel", "reels", "short", "shorts", "tiktok", "youtube",
  "instagram", "insta", "story", "stories",
  // transition / style vocabulary
  "dynamic", "smooth", "fast", "slow", "cinematic", "transition",
  "transitions", "fade", "fades", "crossfade", "dissolve", "zoom", "glitch",
  "whip", "slide", "dip", "black", "effect", "effects", "hard", "soft",
  // generic quality words
  "best", "top", "good", "great", "nice", "cool", "awesome", "epic",
  "highlight", "highlights", "key", "viral", "greatest", "finest",
  "favourite", "favorite", "interesting", "memorable", "standout",
  "recap", "summary", "overview", "wrap", "wrapup",
  // fillers / politeness / connectives
  "the", "a", "an", "this", "that", "these", "those", "it", "its", "my",
  "your", "our", "his", "her", "their", "of", "for", "to", "with", "into",
  "in", "on", "at", "as", "by", "from", "and", "or", "then", "after",
  "before", "also", "just", "only", "please", "pls", "plz", "bro", "da",
  "thanks", "thx", "ok", "okay", "kindly", "now", "lets", "let", "me",
  "i", "we", "you", "should", "would", "can", "could", "will", "is", "are",
  "be", "video's", "one", "some", "any"
]);

// Ordinal words map to source indices in compose; not topics either.
const ORDINAL_WORDS = new Set([
  "first", "second", "third", "fourth", "fifth", "sixth", "seventh",
  "1st", "2nd", "3rd", "4th", "5th", "last", "next"
]);

// =====================================================================
// Normalization — spelling + spacing only. Never expands meaning.
// =====================================================================

// Common single-word spelling fixes for editing/command vocabulary. These
// are generic typos, NOT a topic dictionary.
const SPELL_FIXES: Record<string, string> = {
  atleast: "at least",
  atlease: "at least",
  aleast: "at least",
  alteast: "at least",
  selct: "select",
  slect: "select",
  seclt: "select",
  vedio: "video",
  vidio: "video",
  viddeo: "video",
  vdo: "video",
  vedios: "videos",
  vidios: "videos",
  combien: "combine",
  combinte: "combine",
  verticle: "vertical",
  vertcal: "vertical",
  verical: "vertical",
  horizantal: "horizontal",
  horizntal: "horizontal",
  trasition: "transition",
  trnsition: "transition",
  transtion: "transition"
};

/**
 * Normalize messy user text for interpretation. Spelling + spacing only:
 *  - fix common command/editing typos ("atleast" → "at least"),
 *  - "sect" → "select" ONLY in a clip/video/edit context,
 *  - add the missing space in "5min" / "40sec" / "5clip",
 *  - collapse whitespace.
 * It NEVER expands min→minutes (that conflicts with "min 5 clips" = minimum);
 * the duration/clip-count parsers read units by context instead.
 */
export function normalizeVideoPromptText(input: string): NormalizedPrompt {
  const original = input ?? "";
  const evidence: string[] = [];
  let s = original.toLowerCase();

  // Add a space between a number and an attached unit/noun ("5min" → "5 min").
  s = s.replace(
    /\b(\d+)(min|mins|minute|minutes|sec|secs|second|seconds|hr|hrs|hour|hours|clip|clips|cut|cuts|x)\b/g,
    (_m, n, unit) => {
      evidence.push(`spaced "${n}${unit}" to "${n} ${unit}"`);
      return `${n} ${unit}`;
    }
  );

  // Token-level spelling fixes.
  const tokens = s.split(/\s+/).filter(Boolean);
  const hasClipContext = /\b(clip|clips|cut|cuts|video|videos|edit|part|parts|reel|reels|short|shorts)\b/.test(s);
  const fixed: string[] = [];
  for (const tok of tokens) {
    // Strip trailing punctuation for the lookup but keep it on output.
    const m = tok.match(/^([a-z]+)([^a-z]*)$/);
    const core = m ? m[1] : tok;
    const tail = m ? m[2] : "";
    if (core === "sect") {
      if (hasClipContext) {
        evidence.push('normalized "sect" to "select" (clip context)');
        fixed.push("select" + tail);
        continue;
      }
      fixed.push(tok);
      continue;
    }
    const repl = SPELL_FIXES[core];
    if (repl) {
      evidence.push(`normalized "${core}" to "${repl}"`);
      fixed.push(repl + tail);
    } else {
      fixed.push(tok);
    }
  }

  const normalized = fixed.join(" ").replace(/\s+/g, " ").trim();
  return { normalized, original, evidence };
}

// =====================================================================
// Duration
// =====================================================================
const DURATION_RE = new RegExp(
  `\\b(${NUMBER_ALT})\\s*(hours?|hrs?|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\\b`,
  "i"
);

/**
 * Parse a duration in seconds, or null. Handles "5 min", "5 minutes",
 * "five minutes", "40 sec", "1:30", "make it 5 min". Clamped to
 * VIDEO_PROMPT.durationSeconds. Returns the FIRST stated duration.
 */
export function parseDuration(text: string): number | null {
  const t = (text || "").toLowerCase();

  // Clock form mm:ss takes precedence.
  const clock = t.match(/\b(\d{1,2}):(\d{2})\b/);
  if (clock) {
    const secs = parseInt(clock[1], 10) * 60 + parseInt(clock[2], 10);
    return clampDuration(secs);
  }

  const m = t.match(DURATION_RE);
  if (!m) return null;
  const n = wordToNum(m[1]);
  if (n === null) return null;
  const unit = m[2].toLowerCase();
  let seconds: number;
  if (unit.startsWith("h")) seconds = n * 3600;
  else if (unit === "m" || unit.startsWith("min")) seconds = n * 60;
  else seconds = n; // s / sec / second(s)
  return clampDuration(seconds);
}

function clampDuration(secs: number): number {
  const { min, max } = VIDEO_PROMPT.durationSeconds;
  return Math.min(max, Math.max(min, Math.round(secs)));
}

// =====================================================================
// Clip count
// =====================================================================
const CLIP_NOUNS = new Set([
  "clip", "clips", "cut", "cuts", "piece", "pieces", "section", "sections",
  "segment", "segments", "part", "parts", "moment", "moments", "shot",
  "shots", "highlight", "highlights", "scene", "scenes"
]);

/**
 * Parse clip-count constraints from messy text. Returns whichever of
 * min/max/target it can infer, clamped to VIDEO_PROMPT.clipCount.
 *
 * IMPORTANT (issue #64): a NUMBER counts as a clip count only when a clip
 * noun follows it ("5 clips"). "clip 5" (noun then number) is a clip INDEX
 * and is left for the timeline-edit parser. "5 min" is a duration, not a
 * count, because "min" is not a clip noun.
 */
export function parseClipCount(text: string): ClipCountSlots {
  const tokens = (text || "").toLowerCase().split(/\s+/).filter(Boolean);
  const out: ClipCountSlots = {};

  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i].replace(/[^a-z0-9+]/g, "");
    if (!raw) continue;

    // Number, optionally with a trailing "+".
    const plus = raw.endsWith("+");
    const numTok = plus ? raw.slice(0, -1) : raw;
    const n = wordToNum(numTok);
    if (n === null || n <= 0) continue;

    // A clip noun must appear within the next 2 tokens (allow one filler).
    let nounWithin = false;
    for (let j = i + 1; j <= i + 2 && j < tokens.length; j++) {
      const w = tokens[j].replace(/[^a-z]/g, "");
      if (CLIP_NOUNS.has(w)) {
        nounWithin = true;
        break;
      }
      // stop scanning if we hit a duration unit (then it's a duration)
      if (/^(min|mins|minute|minutes|sec|secs|second|seconds|hour|hours|hr|hrs|m|s|h)$/.test(w)) {
        break;
      }
    }
    if (!nounWithin) continue;

    // Qualifier: look back a few tokens for at-least / at-most / about.
    const window = tokens
      .slice(Math.max(0, i - 4), i)
      .map((w) => w.replace(/[^a-z]/g, ""));
    const has = (...ws: string[]) => ws.some((w) => window.includes(w));

    const clamped = clampCount(n);
    if (plus || has("least", "atleast", "minimum", "min")) {
      out.minClipCount = clamped;
    } else if (has("most", "max", "maximum", "atmost", "upto") || (has("no") && (has("more")))) {
      out.maxClipCount = clamped;
    } else if (has("around", "about", "approximately", "roughly")) {
      out.targetClipCount = clamped;
    } else {
      // Plain "5 clips" → a target count (not min/max).
      out.targetClipCount = clamped;
    }
  }
  return out;
}

function clampCount(n: number): number {
  const { min, max } = VIDEO_PROMPT.clipCount;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// =====================================================================
// Format / platform
// =====================================================================
export function parseFormat(text: string): PromptFormat | null {
  const t = (text || "").toLowerCase();
  if (/\b(vertical|verticle|portrait)\b|9\s*[:x]\s*16/.test(t)) return "vertical";
  if (/\b(horizontal|landscape|widescreen)\b|16\s*[:x]\s*9/.test(t)) return "horizontal";
  if (/\bsquare\b|1\s*[:x]\s*1/.test(t)) return "square";
  // Platform-implied vertical (shorts/reels/tiktok are all 9:16).
  if (/\b(reels?|shorts?|tiktoks?)\b/.test(t)) return "vertical";
  return null;
}

export function parsePlatform(text: string): PromptPlatform {
  const t = (text || "").toLowerCase();
  if (/\btiktoks?\b/.test(t)) return "tiktok";
  if (/\b(instagram|insta|reels?)\b/.test(t)) return "instagram_reels";
  if (/\b(youtube\s*shorts?|shorts?)\b/.test(t)) return "youtube_shorts";
  return "generic";
}

// =====================================================================
// Source scope
// =====================================================================
const ALL_SCOPE_RE =
  /\b(?:from\s+all|all\s+(?:the\s+)?(?:videos?|uploads?|sources?|clips?|footage|files?)|every\s+(?:video|upload|source|clip|file)|each\s+(?:video|upload|source|clip|file)|use\s+all|all\s+of\s+them|across\s+all)\b/;

/**
 * Decide which sources the request targets. "all" wins on explicit
 * all-scope phrasing; otherwise we report ambiguous and let callers default.
 */
export function parseSourceScope(text: string): SourceScopeSlot {
  const t = (text || "").toLowerCase();

  if (ALL_SCOPE_RE.test(t)) {
    return { type: "all", reason: "request references all videos/uploads" };
  }
  // Bare "all"/"every"/"each" near a source/clip noun, looser signal.
  if (/\b(all|every|each)\b/.test(t) && /\b(video|videos|upload|uploads|source|sources|clip|clips|footage)\b/.test(t)) {
    return { type: "all", reason: "all/every/each over videos" };
  }
  return { type: "ambiguous", reason: "no explicit source scope stated" };
}

// =====================================================================
// Meaningful topic detection
// =====================================================================

/** Tokenize to lowercase alphanumeric word tokens. */
function tokenize(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
}

/** True when `tokens` contain at least one real SUBJECT word (not a
 *  meta/editing/output/number/ordinal word). */
export function isMeaningfulContentTopic(tokens: string[]): boolean {
  for (const tok of tokens) {
    const w = tok.toLowerCase();
    if (/^\d/.test(w)) continue; // numbers / "30s" / "9" / "16" are never subjects
    if (w in NUMBER_WORDS) continue;
    if (ORDINAL_WORDS.has(w)) continue;
    if (META_VOCAB.has(w)) continue;
    if (w.length < 2) continue;
    return true;
  }
  return false;
}

/**
 * Extract the meaningful content topic from a clause, or null when the
 * clause is only meta/editing/output words. e.g.
 *   "pick combat in the first video"  → "combat"
 *   "atleast sect all"                → null
 *   "make it as combined 5 min vertical" → null
 */
export function extractMeaningfulTopic(text: string, maxWords = 4): string | null {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of tokenize(text)) {
    if (/^\d/.test(tok)) continue; // numbers / "30s" never subjects
    if (tok in NUMBER_WORDS) continue;
    if (ORDINAL_WORDS.has(tok)) continue;
    if (META_VOCAB.has(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= maxWords) break;
  }
  return out.length > 0 ? out.join(" ") : null;
}

// =====================================================================
// Exclusions ("…but avoid the intro", "without the menu screen")
// =====================================================================
const EXCLUSION_MARKER_RE =
  /\b(?:avoid|avoiding|without|except|excluding|exclude|skip|skipping|ignore|ignoring|but\s+not|but\s+no|don'?t\s+(?:use|include|want)|do\s+not\s+(?:use|include))\b/;

export interface ExclusionSplit {
  /** Text up to the first exclusion marker (where the real topic lives). */
  keep: string;
  /** Meaningful subjects the user asked to exclude (e.g. ["intro"]). */
  exclusions: string[];
}

/**
 * Split a prompt at its first exclusion marker. The `keep` half is where a
 * content topic may be extracted; the tail's meaningful words become the
 * exclusion list so "avoid intro" excludes the intro instead of featuring it.
 */
export function splitExclusions(text: string): ExclusionSplit {
  const t = (text || "").toLowerCase();
  const m = t.match(EXCLUSION_MARKER_RE);
  if (!m || m.index === undefined) {
    return { keep: t, exclusions: [] };
  }
  const keep = t.slice(0, m.index).trim();
  const tail = t.slice(m.index + m[0].length);
  const topic = extractMeaningfulTopic(tail);
  return { keep, exclusions: topic ? topic.split(" ") : [] };
}

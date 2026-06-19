// =====================================================================
// lib/agentic-intake/inferBrief.ts
//
// Builds a partial EditBrief from a single user message + lightweight
// context. PURE: no React, no store, no API. It reuses the existing
// professional prompt interpreter (lib/intent/videoPromptInterpreter) for
// the low-level slot parsing (duration, format, platform, source scope,
// clip count, meaningful topic, exclusions) so there is ONE place that
// understands messy text.
//
// HARD RULES (universal intake):
//   - No genre table. No topic dictionary. No category-specific logic.
//     "gaming" / "wedding" / "cooking" are treated exactly like any other
//     subject word the user typed — they never branch behaviour.
//   - Only generic editing vocabulary, video metadata, and the user's own
//     words inform inference.
//   - We infer OBVIOUS defaults (one video → current scope; a stated
//     platform → its format) and leave genuinely-missing high-impact
//     decisions in `brief.missing` for the question engine.
//
// Value imports are relative (resolved by the test runner's ts-ext hook);
// the EditBrief types are type-only (erased under --experimental-strip-types).
// =====================================================================

import {
  normalizeVideoPromptText,
  parseDuration,
  parseFormat,
  parsePlatform,
  parseSourceScope,
  extractMeaningfulTopic,
  splitExclusions
} from "../intent/videoPromptInterpreter";
import { createEmptyBrief } from "./editBrief";
import type {
  AudioEffect,
  EditBrief,
  IntentKind,
  MissingField,
  OutputFormat,
  OutputPlatform,
  OutputType,
  Pacing,
  TextOverlay,
  VisualEffect
} from "./editBrief";

/** Lightweight, store-agnostic context the inference can read. */
export interface InferContext {
  /** Total uploaded sources in the library. */
  libraryCount: number;
  /** Number of sources the user has ticked for AI use. */
  selectedCount: number;
  /** Clips currently on the timeline. */
  timelineClipCount: number;
  /** Active source id, when one is loaded. */
  hasActiveSource: boolean;
}

const DEFAULT_CTX: InferContext = {
  libraryCount: 0,
  selectedCount: 0,
  timelineClipCount: 0,
  hasActiveSource: false
};

// ---------------------------------------------------------------------
// Generic vocabulary (editing terms only — NOT genres/subjects)
// ---------------------------------------------------------------------

/** Words that signal the user named a concrete deliverable. Their presence
 *  means the OUTPUT STRUCTURE is decided enough not to ask "what should I
 *  make?" — the open question becomes content focus instead. */
const DELIVERABLE_NOUN_RE =
  /\b(shorts?|reels?|videos?|clips?|montages?|trailers?|vlogs?|promos?|teasers?|recaps?|compilations?|stor(?:y|ies)|highlights?|edits?|cuts?)\b/;

const DESCRIBE_RE =
  /\b(describe|what(?:'?s| is| are)?\s+(?:in|happening|going on)|what happens?|tell me about|summar(?:y|ize|ise)|analyse|analyze|breakdown|break down)\b/;

const EXPORT_RE = /\b(export|download|save|render|finish|finalize|finalise|publish)\b/;

const MERGE_RE = /\b(merge|combine|combined|stitch|join|put together|concat)\b/;

const COMPOSE_RE = /\b(montage|interleave|mix|compose|alternat)\b/;

const HIGHLIGHT_RE =
  /\b(best[\s-]?(?:parts?|moments?|bits?|picks?)|highlights?|top moments?|key moments?|greatest|standouts?|recap|funny moments?|viral|most action)\b/;

const CONTINUOUS_RE =
  /\b(continuous(?:ly)?|one (?:single )?(?:clip|short|take)|single (?:clip|take)|keep it (?:as )?one|as one|whole (?:thing|video|clip)|in one (?:go|clip|piece)|uncut|straight through)\b/;

const SPECIFIC_MOMENT_RE =
  /\b(the (?:part|moment|scene|bit) where|find (?:the|a) (?:part|moment|scene)|specific (?:scene|moment|part)|a (?:specific )?scene)\b/;

const FIX_RE =
  /\b(fix|redo|re-?do|change|adjust|tweak|improve|polish|clean up|make it better)\b/;

const STYLE_VERB_RE = /\b(make it|more|less|too)\b/;

/** Mood / vibe descriptors. These are generic STYLE words (allowed), not
 *  genres. They describe how the edit should FEEL, not what it is about. */
const MOOD_WORDS: Record<string, string> = {
  cinematic: "cinematic",
  trailer: "trailer",
  dramatic: "dramatic",
  epic: "epic",
  dark: "dark",
  moody: "moody",
  emotional: "emotional",
  sad: "emotional",
  heartfelt: "emotional",
  funny: "funny",
  comedy: "funny",
  meme: "funny",
  energetic: "energetic",
  hype: "energetic",
  intense: "intense",
  calm: "calm",
  chill: "calm",
  relaxing: "calm",
  aesthetic: "aesthetic",
  clean: "clean",
  minimal: "clean",
  simple: "clean",
  luxury: "premium",
  premium: "premium",
  elegant: "premium",
  nostalgic: "nostalgic",
  vintage: "nostalgic",
  educational: "educational",
  professional: "professional",
  cool: "cool"
};

const FAST_RE = /\b(fast|fast-?paced|snappy|quick cuts?|high energy|punchy|rapid)\b/;
const SLOW_RE = /\b(slow|slow-?paced|relaxed|calm|gentle|smooth and slow)\b/;

/** Words that describe STYLE/SCOPE/STRUCTURE, never CONTENT. They are
 *  stripped before topic extraction so "dark trailer" / "current video"
 *  never become a fabricated content focus. Built from the mood vocabulary
 *  plus generic pointer/scope words. NOT a genre table. */
const NON_TOPIC_WORDS = new Set<string>([
  ...Object.keys(MOOD_WORDS),
  ...Object.values(MOOD_WORDS),
  "current",
  "active",
  "selected",
  "whole",
  "entire",
  "both",
  "continuous",
  "continuously",
  "trailer",
  "vibe",
  "style",
  "mood",
  "feel",
  "looking",
  "look"
]);

/** Remove style/scope words so they cannot be mistaken for a content topic. */
function stripNonTopicWords(text: string): string {
  return text
    .split(/\s+/)
    .filter((w) => !NON_TOPIC_WORDS.has(w.replace(/[^a-z]/g, "")))
    .join(" ");
}

// ---------------------------------------------------------------------
// Effect detection (generic editing terms only)
// ---------------------------------------------------------------------

const VISUAL_EFFECT_PATTERNS: Array<[RegExp, VisualEffect]> = [
  [/\b(slow zoom|ken burns|zoom in|zoom out|slow push)\b/, "slow_zoom"],
  [/\b(speed ramp|speed-?ramp|ramping)\b/, "speed_ramp"],
  [/\b(speed up|speed change|slow ?mo|slow motion|timelapse|time-?lapse|fast forward)\b/, "speed_change"],
  [/\b(color grade|colour grade|color grading|grade the|teal and orange|lut)\b/, "color_grade"],
  [/\b(camera shake|shake|handheld)\b/, "camera_shake"],
  [/\b(letterbox|cinematic bars|black bars)\b/, "letterbox"],
  [/\b(captions?|subtitles?)\b/, "captions"],
  [/\b(text overlay|on-?screen text|add text|title card|titles?)\b/, "text_overlay"],
  [/\b(blur|gaussian|defocus)\b/, "blur"],
  [/\b(crop|reframe|re-?frame|recompose)\b/, "crop_reframe"]
];

const AUDIO_EFFECT_PATTERNS: Array<[RegExp, AudioEffect]> = [
  [/\b(keep (?:the )?(?:original )?audio|keep sound|original audio|keep the voice)\b/, "keep_original"],
  [/\b(lower (?:the )?(?:original )?audio|duck (?:the )?audio|quieter audio|reduce audio)\b/, "lower_original"],
  [/\b(mute|no audio|remove (?:the )?audio|silent|no sound)\b/, "mute_original"],
  [/\b(bass|bass hit|boom|impact sound)\b/, "bass_hit"],
  [/\b(whoosh|swoosh|transition sound|swish)\b/, "whoosh"],
  [/\b(background music|bgm|add music|music track|soundtrack)\b/, "background_music"],
  [/\b(voice ?over|narration|narrate)\b/, "voiceover"]
];

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/** Detect an explicit time RANGE like "0:00 to 0:35" / "10s - 40s". */
function detectExplicitRange(text: string): boolean {
  const t = text.toLowerCase();
  // two clock-ish endpoints joined by to / - / until / through
  const clockRange =
    /\b\d{1,2}:\d{2}\s*(?:to|-|–|until|through|thru)\s*\d{1,2}:\d{2}\b/;
  const secRange =
    /\b\d+\s*(?:s|sec|secs|seconds)?\s*(?:to|-|–|until|through|thru)\s*\d+\s*(?:s|sec|secs|seconds|m|min|mins|minutes)\b/;
  return clockRange.test(t) || secRange.test(t);
}

/** Pull text overlay lines from quotes or an explicit "text: a, b, c" list. */
function extractTextOverlays(rawText: string): TextOverlay[] {
  const overlays: TextOverlay[] = [];
  const seen = new Set<string>();

  const push = (s: string) => {
    const text = s.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
    if (text.length < 1 || text.length > 120) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    overlays.push({ text, timing: "auto", priority: overlays.length + 1 });
  };

  // 1) Quoted lines: "...", '...', “...”
  const quoteRe = /["'“‘]([^"'”’\n]{1,120})["'”’]/g;
  let m: RegExpExecArray | null;
  while ((m = quoteRe.exec(rawText)) !== null) push(m[1]);

  // 2) Explicit list after a text marker: "add these texts: a, b, c"
  if (overlays.length === 0) {
    const listMatch = rawText.match(
      /\b(?:add (?:these )?(?:texts?|captions?|lines?|titles?)|texts?|captions?|lines?)\s*[:\-]\s*(.+)$/i
    );
    if (listMatch) {
      const tail = listMatch[1];
      const parts = tail.split(/\s*(?:,|;|\/|\band\b|\n|\u2022|\||\bthen\b)\s*/i);
      for (const p of parts) push(p);
    }
  }

  return overlays;
}

function detectVisualEffects(text: string): VisualEffect[] {
  const out: VisualEffect[] = [];
  for (const [re, effect] of VISUAL_EFFECT_PATTERNS) {
    if (re.test(text) && !out.includes(effect)) out.push(effect);
  }
  return out;
}

function detectAudioEffects(text: string): AudioEffect[] {
  const out: AudioEffect[] = [];
  for (const [re, effect] of AUDIO_EFFECT_PATTERNS) {
    if (re.test(text) && !out.includes(effect)) out.push(effect);
  }
  return out;
}

function detectMood(text: string): string | undefined {
  for (const [word, mood] of Object.entries(MOOD_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(text)) return mood;
  }
  return undefined;
}

function detectPacing(text: string): Pacing {
  if (FAST_RE.test(text)) return "fast";
  if (SLOW_RE.test(text)) return "slow";
  return "unknown";
}

function platformFormat(platform: OutputPlatform): OutputFormat | undefined {
  switch (platform) {
    case "youtube_shorts":
    case "instagram_reels":
    case "tiktok":
      return "vertical";
    case "youtube":
    case "linkedin":
      return "horizontal";
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------
// Source scope inference
// ---------------------------------------------------------------------

function inferSourceScope(
  text: string,
  ctx: InferContext
): { type: EditBrief["sourceScope"]["type"]; reason: string; confidence: number } {
  const t = text.toLowerCase();

  if (/\b(current (?:video|clip|one)|this (?:video|clip|one)|use current|active (?:video|clip))\b/.test(t)) {
    return { type: "current", reason: "user referenced the current video", confidence: 0.9 };
  }
  if (/\b(selected (?:videos?|clips?|sources?)|the (?:ones|videos?) i (?:picked|selected|ticked))\b/.test(t)) {
    return { type: "selected", reason: "user referenced the selected videos", confidence: 0.85 };
  }

  const scope = parseSourceScope(t);
  if (scope.type === "all") {
    return { type: "all", reason: scope.reason, confidence: 0.85 };
  }

  // Obvious default: only one (or zero) source → there's nothing to choose.
  if (ctx.libraryCount <= 1) {
    return {
      type: "current",
      reason: ctx.libraryCount === 1 ? "only one video is uploaded" : "no library yet — assume the current video",
      confidence: ctx.libraryCount === 1 ? 0.8 : 0.4
    };
  }

  // Multiple "these"/"them" with a merge verb leans to selected/all but is
  // genuinely ambiguous — leave it for the question engine.
  return { type: "unknown", reason: "multiple videos and no explicit scope", confidence: 0.2 };
}

// ---------------------------------------------------------------------
// Intent + output-type inference
// ---------------------------------------------------------------------

function inferIntent(
  text: string,
  ctx: InferContext,
  hasExplicitRange: boolean
): { intentKind: IntentKind; outputType?: OutputType; confidence: number } {
  const t = text.toLowerCase();

  if (DESCRIBE_RE.test(t) && !/\b(make|create|build|edit|turn (?:this )?into|generate|produce)\b/.test(t)) {
    return { intentKind: "describe_video", confidence: 0.85 };
  }
  // Export only when it's clearly the whole ask (no "make" content verb).
  if (EXPORT_RE.test(t) && !/\b(make|create|build|edit|turn into|reel|short|highlight)\b/.test(t)) {
    return { intentKind: "export_render", confidence: 0.8 };
  }
  if (hasExplicitRange) {
    return { intentKind: "extract_range", outputType: "single_continuous", confidence: 0.85 };
  }

  const isMerge = MERGE_RE.test(t);
  const isCompose = COMPOSE_RE.test(t);
  if (isMerge || isCompose) {
    // "combine as-is / just combine" → as_is_merge; "combine the best parts" → compose montage
    const asIs = /\b(as[\s-]?is|as it is|just (?:combine|merge|join)|whole videos?|full videos?|back to back)\b/.test(t);
    if (isCompose && !asIs) {
      return { intentKind: "compose_montage", outputType: "multi_clip", confidence: 0.7 };
    }
    return {
      intentKind: "merge_sources",
      outputType: asIs ? "as_is_merge" : HIGHLIGHT_RE.test(t) ? "multi_clip" : undefined,
      confidence: 0.7
    };
  }

  if (CONTINUOUS_RE.test(t)) {
    return { intentKind: "continuous_clip", outputType: "single_continuous", confidence: 0.8 };
  }
  if (HIGHLIGHT_RE.test(t)) {
    return { intentKind: "highlight_reel", outputType: "multi_clip", confidence: 0.8 };
  }

  // Styling/fixing an EXISTING timeline (only meaningful once clips exist).
  if (ctx.timelineClipCount > 0) {
    if (FIX_RE.test(t)) {
      return { intentKind: "fix_existing_edit", confidence: 0.6 };
    }
    if (STYLE_VERB_RE.test(t) && detectMood(t)) {
      return { intentKind: "style_existing_timeline", confidence: 0.55 };
    }
  }

  // "the part where ..." style targeted moment.
  if (SPECIFIC_MOMENT_RE.test(t)) {
    return { intentKind: "specific_moment", outputType: "single_continuous", confidence: 0.65 };
  }

  // A generic creation ask ("make a reel", "make this cool", "edit for youtube").
  if (/\b(make|create|build|edit|turn (?:this )?into|generate|produce)\b/.test(t) || DELIVERABLE_NOUN_RE.test(t)) {
    return { intentKind: "create_short", confidence: 0.5 };
  }

  return { intentKind: "unknown", confidence: 0.2 };
}

// ---------------------------------------------------------------------
// Missing-field computation (depends on live context)
// ---------------------------------------------------------------------

/**
 * Compute the high-impact missing fields for a brief, given context.
 * Only BLOCKING decisions land here — duration/format/style/text/audio
 * have safe defaults and are inferred, not forced as questions, unless
 * they are the only thing a bare request is missing.
 */
export function computeMissing(brief: EditBrief, ctx: InferContext): MissingField[] {
  const missing: MissingField[] = [];
  const kind = brief.intentKind;

  // Intents that need no creation questions.
  if (kind === "describe_video" || kind === "export_render") return [];

  // 1) Source scope — only a question when there's a genuine choice.
  if (brief.sourceScope.type === "unknown" && ctx.libraryCount > 1) {
    missing.push("source_scope");
  }

  // 2) Output type — only when the user gave no deliverable structure.
  const hasStructure =
    brief.output.outputType !== undefined ||
    DELIVERABLE_NOUN_RE.test(brief.rawUserText.toLowerCase()) ||
    kind === "continuous_clip" ||
    kind === "highlight_reel" ||
    kind === "extract_range" ||
    kind === "merge_sources" ||
    kind === "compose_montage" ||
    kind === "specific_moment";
  if (!hasStructure) {
    missing.push("output_type");
  }

  // 3) Content focus — needed for creation reels unless it's a generic
  //    best-parts ask, a verbatim range, a specific moment, or an as-is merge.
  const focusResolved =
    Boolean(brief.content.focus) ||
    brief.content.genericBestParts === true ||
    Boolean(brief.content.momentDescription) ||
    brief.output.outputType === "as_is_merge" ||
    brief.output.outputType === "single_continuous" ||
    kind === "extract_range" ||
    kind === "specific_moment";
  const needsFocus =
    kind === "create_short" ||
    kind === "highlight_reel" ||
    kind === "continuous_clip" ||
    kind === "compose_montage" ||
    (kind === "merge_sources" && brief.output.outputType !== "as_is_merge");
  if (needsFocus && !focusResolved) {
    missing.push("content_focus");
  }

  return missing;
}

// ---------------------------------------------------------------------
// Finalize: apply context defaults + recompute missing
// ---------------------------------------------------------------------

/**
 * Apply obvious context-driven defaults to a (possibly merged) brief and
 * recompute `missing`. Safe to call after mergeBrief.
 */
export function finalizeBrief(brief: EditBrief, ctx: InferContext = DEFAULT_CTX): EditBrief {
  const out: EditBrief = { ...brief };

  // Single-video library → current scope (nothing to choose).
  if (out.sourceScope.type === "unknown" && ctx.libraryCount <= 1) {
    out.sourceScope = {
      type: "current",
      reason: ctx.libraryCount === 1 ? "only one video is uploaded" : "assume the current video"
    };
    out.confidence = { ...out.confidence, sourceScope: Math.max(out.confidence.sourceScope, 0.7) };
  }

  // A stated platform with no explicit format → its canonical format.
  if (!out.output.format && out.output.platform) {
    const fmt = platformFormat(out.output.platform);
    if (fmt) {
      out.output = { ...out.output, format: fmt };
      out.confidence = { ...out.confidence, format: Math.max(out.confidence.format, 0.7) };
    }
  }

  // "current video only" style scope implies the no-extra-sources constraint.
  if (out.sourceScope.type === "current") {
    out.constraints = {
      ...out.constraints,
      noExtraSources: out.constraints.noExtraSources ?? true,
      doNotAskForAnotherClip: out.constraints.doNotAskForAnotherClip ?? true
    };
  }

  // Continuous output implies no inter-clip transitions to ask about.
  if (out.output.outputType === "single_continuous") {
    out.constraints = {
      ...out.constraints,
      userSaidContinuous: out.constraints.userSaidContinuous ?? true,
      noTransitionsBetweenClips: out.constraints.noTransitionsBetweenClips ?? true
    };
  }

  out.missing = computeMissing(out, ctx);
  return out;
}

// ---------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------

/**
 * Infer a partial EditBrief from one user message. Pure + deterministic.
 * Combine across turns with mergeBrief, then finalize against live context.
 */
export function inferBrief(userText: string, ctx: InferContext = DEFAULT_CTX): EditBrief {
  const brief = createEmptyBrief(userText);
  const { normalized } = normalizeVideoPromptText(userText);
  const lower = normalized;

  // ---- exclusions: split off "...but avoid X" before topic extraction ----
  const { keep, exclusions } = splitExclusions(lower);
  if (exclusions.length > 0) {
    brief.content.avoid = exclusions;
  }

  // ---- output: duration / format / platform ----
  const duration = parseDuration(lower);
  if (duration !== null) {
    brief.output.durationSeconds = duration;
    brief.confidence.duration = 0.9;
  }

  const platform = parsePlatform(lower);
  if (platform !== "generic") {
    brief.output.platform = platform as OutputPlatform;
  } else if (/\byoutube\b/.test(lower) && !/\bshorts?\b/.test(lower)) {
    brief.output.platform = "youtube";
  } else if (/\blinked ?in\b/.test(lower)) {
    brief.output.platform = "linkedin";
  }

  const fmt = parseFormat(lower);
  if (fmt) {
    brief.output.format = fmt as OutputFormat;
    brief.confidence.format = 0.85;
  }

  // ---- source scope ----
  const scope = inferSourceScope(lower, ctx);
  brief.sourceScope = { type: scope.type, reason: scope.reason };
  brief.confidence.sourceScope = scope.confidence;

  // ---- intent + output type ----
  const hasExplicitRange = detectExplicitRange(lower);
  const intent = inferIntent(lower, ctx, hasExplicitRange);
  brief.intentKind = intent.intentKind;
  brief.confidence.intent = intent.confidence;
  if (intent.outputType) brief.output.outputType = intent.outputType;

  if (hasExplicitRange) {
    brief.content.momentDescription = userText.trim();
  }

  // ---- content focus + generic best-parts ----
  const HIGHLIGHT_RE_LOCAL = HIGHLIGHT_RE;
  const topic = extractMeaningfulTopic(stripNonTopicWords(keep));
  if (topic) {
    brief.content.focus = topic;
  } else if (HIGHLIGHT_RE_LOCAL.test(lower) || /\b(best|highlights?|cool|interesting)\b/.test(lower)) {
    // Generic "best parts / make this cool" ask with no concrete subject:
    // score for broad visual interest, never literal SigLIP on "best".
    brief.content.genericBestParts = true;
  }

  // ---- style: mood + pacing + tone ----
  const mood = detectMood(lower);
  if (mood) {
    brief.style.mood = mood;
    brief.confidence.style = 0.7;
  }
  const pacing = detectPacing(lower);
  if (pacing !== "unknown") {
    brief.style.pacing = pacing;
    if (brief.confidence.style < 0.5) brief.confidence.style = 0.5;
  }

  // ---- effects (captured as REQUESTS; capability honesty applied later) ----
  const visualEffects = detectVisualEffects(lower);
  if (visualEffects.length > 0) brief.effects.requestedVisualEffects = visualEffects;
  const audioEffects = detectAudioEffects(lower);
  if (audioEffects.length > 0) {
    brief.effects.requestedAudioEffects = audioEffects;
    if (audioEffects.includes("keep_original")) {
      brief.constraints.preserveOriginalAudio = true;
    }
    if (audioEffects.includes("mute_original")) {
      brief.constraints.preserveOriginalAudio = false;
    }
  }

  // ---- text overlays (from quotes or explicit list) ----
  const overlays = extractTextOverlays(userText);
  if (overlays.length > 0) {
    brief.effects.textOverlays = overlays;
    const v = brief.effects.requestedVisualEffects ?? [];
    if (!v.includes("text_overlay")) v.push("text_overlay");
    brief.effects.requestedVisualEffects = v;
    brief.content.transcriptNeed = brief.content.transcriptNeed ?? "none";
  }

  // ---- transcript need (captions vs quotes) ----
  if (/\b(captions?|subtitles?)\b/.test(lower)) {
    brief.content.transcriptNeed = "captions";
  } else if (/\b(quotes?|what (?:he|she|they) said|key points?|key lines?)\b/.test(lower)) {
    brief.content.transcriptNeed = "quotes";
  }

  return finalizeBrief(brief, ctx);
}

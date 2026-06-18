// =====================================================================
// lib/plan/composeIntent.ts
//
// Deterministic MULTI-SOURCE COMPOSE detector — a high-precision SAFETY
// NET that runs with PRIORITY over the generic single-source
// `deriveActionableIntent` fallback.
//
// It now sits on top of the professional prompt interpreter
// (lib/intent/videoPromptInterpreter.ts), which normalizes messy text and
// extracts structured slots (duration, clip count, format, source scope,
// MEANINGFUL topic). This is what fixes issue #64: meta/output words like
// "atleast sect all" / "min vertical" can no longer become source topics.
//
// Two compose shapes are produced:
//   1. PER-SOURCE semantic compose — "combat in the first video and the
//      cutscene in the second" → distinct queries per source (unchanged).
//   2. ALL-SOURCES compose — "select at least 5 clips from all videos and
//      make a combined 5 min vertical video" → a generic (or single-topic)
//      compose fanned across EVERY upload, carrying duration / format /
//      min-clip-count, never inventing per-source topics.
//
// Precision over recall: returns null when the prompt isn't clearly a
// multi-source request, so normal single-source / merge / edit prompts are
// untouched.
//
// Dependency-light: `import type` from @/lib/types (stripped by the Node
// test runner) + value helpers from the interpreter (relative path, resolved
// by the test runner's ts-ext hook). Unit-testable with `node --test`.
// =====================================================================

import type {
  ComposeOrdering,
  ComposeSourceSelection,
  ComposeTransition,
  ComposeTransitionType,
  MultiSourceComposePlan
} from "@/lib/types";
import {
  normalizeVideoPromptText,
  parseDuration,
  parseFormat,
  parseClipCount,
  parseSourceScope,
  extractMeaningfulTopic,
  splitExclusions
} from "../intent/videoPromptInterpreter";

export interface ComposeIntentResult {
  plan: MultiSourceComposePlan;
  message: string;
  /** "high" → clear multi-source (≥2 source refs with topics, an all-sources
   *  compose, or an anchor-first shuffle). "low" → a softer signal used only
   *  in fallback sites (planner failed / clarify / unusable). */
  confidence: "high" | "low";
}

const ORDINALS: Record<string, number> = {
  first: 0, second: 1, third: 2, fourth: 3, fifth: 4,
  "1st": 0, "2nd": 1, "3rd": 2, "4th": 3, "5th": 4
};
const ORDINAL_NAMES = ["first", "second", "third", "fourth", "fifth"];
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5
};

function parseNum(token: string): number | null {
  if (/^\d+$/.test(token)) {
    const n = parseInt(token, 10);
    return Number.isFinite(n) ? n : null;
  }
  return NUMBER_WORDS[token] ?? null;
}

/**
 * Find the source index referenced inside a clause, or null. Three passes,
 * most explicit first:
 *   1. "video 2" / "upload 1" / "clip 3" (noun + number).
 *   2. "first video" / "second upload" (ordinal + source noun).
 *   3. "in the second" / "from the first" (bare ordinal after a
 *      preposition), guarded so "the first 30 seconds" never matches.
 */
export function findSourceIndex(clause: string): number | null {
  const c = clause.toLowerCase();

  const vm = c.match(
    /\b(?:video|upload|clip|vid|source|file)\s*#?\s*(\d{1,2}|one|two|three|four|five)\b/
  );
  if (vm) {
    const n = parseNum(vm[1]);
    if (n && n >= 1) return n - 1;
  }

  const om = c.match(
    /\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+(?:video|upload|clip|vid|footage|source|file|one)\b/
  );
  if (om) return ORDINALS[om[1]];

  const bm = c.match(
    /\b(?:the|from|in|on|to)\s+(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\b(?!\s+\d)(?!\s+(?:sec|secs|second|seconds|min|mins|minute|minutes))/
  );
  if (bm) return ORDINALS[bm[1]];

  return null;
}

/** Detect a transition request from the whole text. Defaults to "auto"
 *  (montages want a transition; the client resolves it per boundary). */
function detectTransition(lower: string): ComposeTransition {
  let type: ComposeTransitionType = "auto";
  if (/\bglitch\b/.test(lower)) type = "glitch";
  else if (/\bwhip\b/.test(lower)) type = "whip";
  else if (/\bzoom\b/.test(lower)) type = "zoom";
  else if (/match\s*cut/.test(lower)) type = "match_cut";
  else if (/cross\s*fade|crossfade|cinematic/.test(lower)) type = "crossfade";
  else if (/\bfade\b/.test(lower)) type = "fade";
  else if (/hard\s*cut|\bfast\b/.test(lower)) type = "cut";
  return { type };
}

function detectOrdering(lower: string): ComposeOrdering["type"] {
  if (/\bshuffl/.test(lower)) return "shuffle";
  if (/\b(mix|mixing|alternat|interleav)/.test(lower)) return "interleave";
  if (/\bstory\b|\bnarrative\b|story\s*arc/.test(lower)) return "story_arc";
  if (/energy|build up|build-up|ramp/.test(lower)) return "energy_curve";
  return "source_order";
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return items.join(", ");
}

/** Human duration label, e.g. 300 → "5-minute", 30 → "30-second". */
function durationLabel(seconds: number): string {
  if (seconds % 60 === 0) {
    const m = seconds / 60;
    return `${m}-minute`;
  }
  if (seconds < 60) return `${seconds}-second`;
  const m = Math.round((seconds / 60) * 10) / 10;
  return `${m}-minute`;
}

interface OutputExtras {
  targetSeconds?: number;
  format?: "vertical" | "horizontal" | "square";
  minClipCount?: number;
  avoid?: string[];
}

function applyExtras(
  plan: MultiSourceComposePlan,
  extras: OutputExtras
): MultiSourceComposePlan {
  const out = { ...plan };
  if (extras.targetSeconds !== undefined) {
    out.targetSeconds = extras.targetSeconds;
    out.userSpecifiedDuration = true;
  }
  if (extras.format) out.format = extras.format;
  if (extras.minClipCount !== undefined) out.minClipCount = extras.minClipCount;
  return out;
}

function buildResult(
  sources: ComposeSourceSelection[],
  ordering: ComposeOrdering,
  transition: ComposeTransition,
  confidence: "high" | "low",
  picks: Array<{ index: number; baseTopic: string }>,
  extras: OutputExtras = {}
): ComposeIntentResult {
  const name = "AI Combined 1";

  // Add a dynamic-rule hint when the transition is auto and we know the two
  // bordering topics — gives the client's resolver a clean explanation.
  if (transition.type === "auto" && picks.length >= 2) {
    transition = {
      ...transition,
      dynamicRule: `choose a transition that fits ${picks[0].baseTopic} into ${picks[1].baseTopic}`
    };
  }

  const fmtSuffix = extras.format ? ` (${extras.format})` : "";
  const durPrefix = extras.targetSeconds
    ? `a ${durationLabel(extras.targetSeconds)} `
    : "";

  let message: string;
  if (picks.length >= 2) {
    const parts = picks.map(
      (p) => `${p.baseTopic} from the ${ORDINAL_NAMES[p.index] ?? `#${p.index + 1}`} video`
    );
    message = `Got it \u2014 I\u2019ll build ${durPrefix}${name}${fmtSuffix} with ${joinList(parts)}`;
    message +=
      transition.type === "cut"
        ? ", with hard cuts."
        : `, and a ${transition.type === "auto" ? "dynamic" : transition.type} transition.`;
  } else if (ordering.type === "shuffle" && ordering.anchorFirst) {
    message = `Got it \u2014 I\u2019ll build ${name}: the first video leads, then I\u2019ll shuffle the rest.`;
  } else {
    const verb =
      ordering.type === "interleave"
        ? "interleaving"
        : ordering.type === "shuffle"
          ? "shuffling"
          : "combining";
    message = `Got it \u2014 I\u2019ll build ${name} by ${verb} your videos.`;
  }

  const plan = applyExtras(
    {
      outputTarget: { type: "new_timeline_slot", name },
      sources,
      ordering,
      transition,
      sourceScope: "explicit",
      needsAnalysis: true
    },
    extras
  );

  return { plan, message, confidence };
}

/**
 * Build an ALL-SOURCES compose result. No per-source topics are invented;
 * the client fans the request out across every eligible upload using either
 * a single shared topic or broad visual-interest selection.
 */
function buildAllSourceResult(args: {
  sharedTopic: string | null;
  targetSeconds: number | null;
  format: "vertical" | "horizontal" | "square" | null;
  minClipCount?: number;
  transition: ComposeTransition;
  ordering: ComposeOrdering["type"];
  avoid: string[];
}): ComposeIntentResult {
  const name = "AI Combined 1";
  const genericBestParts = !args.sharedTopic;

  const plan: MultiSourceComposePlan = {
    outputTarget: { type: "new_timeline_slot", name },
    sources: [], // client expands to all eligible uploads at run time
    ordering: { type: args.ordering },
    transition: args.transition,
    sourceScope: "all",
    genericBestParts,
    needsAnalysis: true,
    ...(args.sharedTopic ? { allSourcesTopic: args.sharedTopic } : {}),
    ...(args.targetSeconds
      ? { targetSeconds: args.targetSeconds, userSpecifiedDuration: true }
      : {}),
    ...(args.format ? { format: args.format } : {}),
    ...(args.minClipCount ? { minClipCount: args.minClipCount } : {})
  };

  // Clean, professional confirmation built ONLY from real slots.
  const durPart = args.targetSeconds ? `${durationLabel(args.targetSeconds)} ` : "";
  const fmtPart = args.format ? `${args.format} ` : "";
  let message = `Got it \u2014 I\u2019ll build a ${durPart}${fmtPart}combined video from all uploaded videos`;
  if (args.sharedTopic) message += `, focusing on ${args.sharedTopic}`;
  if (args.minClipCount) {
    message += `, using at least ${args.minClipCount} ${genericBestParts ? "best-moment " : ""}clips`;
  } else if (genericBestParts) {
    message += `, using the best moments from each`;
  }
  if (args.avoid.length > 0) message += `, avoiding ${joinList(args.avoid)}`;
  message +=
    args.transition.type === "cut"
      ? ", with hard cuts."
      : ", with automatic transitions.";

  return { plan, message, confidence: "high" };
}

/**
 * Detect a multi-source compose intent from the user's text. Returns null
 * when the prompt is not clearly multi-source (the caller then proceeds
 * with the cloud planner / single-source fallback).
 */
export function deriveComposeIntent(
  userText: string
): ComposeIntentResult | null {
  const raw = (userText || "").trim();
  if (!raw) return null;

  // Normalize messy text once (spelling/spacing only) and extract slots.
  const { normalized: lower } = normalizeVideoPromptText(raw);

  const targetSeconds = parseDuration(lower);
  const format = parseFormat(lower);
  const clipCounts = parseClipCount(lower);
  const scope = parseSourceScope(lower);
  const minClipCount = clipCounts.minClipCount ?? clipCounts.targetClipCount;
  const { keep: topicText, exclusions } = splitExclusions(lower);

  const hasShuffle = /\bshuffl/.test(lower);
  const hasMix = /\b(mix|mixing|alternat|interleav)/.test(lower);
  const hasCombine = /\bcombin/.test(lower);
  const hasMontage = /\bmontage\b/.test(lower);
  const ordering = detectOrdering(lower);
  const transition = detectTransition(lower);
  const anchorFirst =
    hasShuffle && /\bfirst\b/.test(lower) && /(then|after|rest)/.test(lower);

  // Parse clauses ("X in the first video" AND "Y in the second" AND …). Topic
  // tokens come from the interpreter, so meta/output words never leak in.
  const clauses = topicText.split(/\band\b/);
  const picks: Array<{ index: number; baseTopic: string; query: string }> = [];
  const looseTopics: string[] = [];
  let sawSourceRef = false;
  for (const clause of clauses) {
    const idx = findSourceIndex(clause);
    if (idx !== null) sawSourceRef = true;
    const topic = extractMeaningfulTopic(clause);
    if (idx !== null && topic) {
      picks.push({ index: idx, baseTopic: topic, query: `${topic} moments` });
    } else if (topic) {
      looseTopics.push(topic);
    }
  }

  const distinctIdx = new Set(picks.map((p) => p.index));
  const multiCue =
    sawSourceRef ||
    /\bvideos\b|\bclips\b|\buploads\b|\bthem\b|\bthe rest\b|\beach\b|\ball of them\b/.test(
      lower
    );

  const sharedExtras: OutputExtras = {
    ...(targetSeconds !== null ? { targetSeconds } : {}),
    ...(format ? { format } : {}),
    ...(minClipCount !== undefined ? { minClipCount } : {})
  };

  // ---- Tier A: ≥2 explicit per-source picks (combat in #1, cutscene in #2)
  if (picks.length >= 2 && distinctIdx.size >= 2) {
    const sources: ComposeSourceSelection[] = picks
      .slice(0, 8)
      .map((p, i) => ({
        sourceRef: { type: "index", index: p.index },
        query: p.query,
        role: "segment",
        order: i + 1
      }));
    return buildResult(
      sources,
      { type: ordering },
      transition,
      "high",
      picks,
      sharedExtras
    );
  }

  // ---- All-sources compose (issue #64). Fires on an explicit all-videos
  //      scope plus ANY build/combine cue OR an output constraint. No fake
  //      per-source topics — generic visual-interest unless ONE real shared
  //      topic survives (e.g. "cooking from all videos").
  const wantsBuild =
    hasCombine ||
    hasMontage ||
    /\b(make|build|create|generate|produce|select|combine|reel|reels|short|shorts|montage|tiktoks?)\b/.test(
      lower
    );
  const hasOutputConstraint =
    targetSeconds !== null || minClipCount !== undefined || format !== null;
  if (scope.type === "all" && (wantsBuild || hasOutputConstraint)) {
    const sharedTopic = extractMeaningfulTopic(topicText);
    return buildAllSourceResult({
      sharedTopic,
      targetSeconds,
      format,
      minClipCount,
      transition,
      ordering,
      avoid: exclusions
    });
  }

  // ---- Tier B: mix/combine/montage trigger + ≥2 MEANINGFUL content topics
  if (
    (hasMix || hasCombine || hasMontage) &&
    picks.length + looseTopics.length >= 2
  ) {
    const topics = [...picks.map((p) => p.baseTopic), ...looseTopics].slice(0, 8);
    const sources: ComposeSourceSelection[] = topics.map((t, i) => ({
      sourceRef: { type: "index", index: i },
      query: `${t} moments`,
      role: "segment",
      order: i + 1
    }));
    const ord: ComposeOrdering["type"] = hasMix ? "interleave" : ordering;
    return buildResult(
      sources,
      { type: ord },
      transition,
      multiCue ? "high" : "low",
      topics.map((t, i) => ({ index: i, baseTopic: t })),
      sharedExtras
    );
  }

  // ---- Tier C: ordering-only montage ("first video first then shuffle the
  //      rest", "shuffle the videos", "montage these")
  if ((hasShuffle || hasMix || hasMontage) && multiCue) {
    const sources: ComposeSourceSelection[] = [0, 1].map((i) => ({
      sourceRef: { type: "index", index: i },
      query: "",
      role: "segment",
      order: i + 1
    }));
    const ord: ComposeOrdering = anchorFirst
      ? { type: "shuffle", anchorFirst: true }
      : { type: ordering };
    return buildResult(
      sources,
      ord,
      transition,
      anchorFirst ? "high" : "low",
      [],
      sharedExtras
    );
  }

  return null;
}

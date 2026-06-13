// =====================================================================
// lib/plan/composeIntent.ts
//
// Deterministic MULTI-SOURCE COMPOSE detector — a high-precision SAFETY
// NET that runs with PRIORITY over the generic single-source
// `deriveActionableIntent` fallback.
//
// Why this exists: the cloud planner kept mis-routing clear multi-source
// montage requests ("pick combat in the first video and the cutscene in
// the second and make it transition") into single-source plans, and the
// generic fallback then built junk scenarios from words like "pick" /
// "first" / "transition". This module reads the user's text and, when it
// confidently sees picks from MORE THAN ONE source (or an explicit
// cross-source ordering directive), returns a ready MultiSourceComposePlan
// so the route can answer with mode "compose" before any generic fallback.
//
// Precision over recall: it only fires on clear multi-source patterns and
// returns null otherwise, so normal single-source / merge / edit prompts
// are untouched.
//
// Dependency-free at runtime (only `import type`, stripped by the Node test
// runner) so it can be unit-tested with `--experimental-strip-types`.
// =====================================================================

import type {
  ComposeOrdering,
  ComposeSourceSelection,
  ComposeTransition,
  ComposeTransitionType,
  MultiSourceComposePlan
} from "@/lib/types";

export interface ComposeIntentResult {
  plan: MultiSourceComposePlan;
  message: string;
  /** "high" → clear multi-source (≥2 source refs with topics, or an
   *  anchor-first shuffle). The route uses this to OVERRIDE the cloud
   *  planner. "low" → a softer signal (e.g. "mix combat and cutscene")
   *  used only in fallback sites (planner failed / clarify / unusable). */
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

// Words removed when extracting the CONTENT topic from a clause. Generic
// commands / fillers / source nouns / ordering+transition words — never a
// subject. (Keeps "combat", "cutscene", "jokes", "story", "ingredient", …;
// drops "pick", "first", "video", "transition", "mix", …)
const TOPIC_STOP = new Set([
  "pick", "picking", "picked", "take", "taking", "use", "using", "used",
  "get", "getting", "grab", "grabbing", "show", "showing", "want", "need",
  "make", "making", "add", "adding", "put", "putting", "include", "including",
  "give", "giving", "do",
  "the", "a", "an", "this", "that", "these", "those", "it", "its", "my",
  "your", "our", "his", "her", "their",
  "of", "for", "from", "to", "with", "into", "or", "then", "after", "before",
  "also", "just", "only", "should", "start", "starts", "starting", "rest",
  "lead", "leads", "leading", "and", "in", "on", "at", "as", "by",
  "video", "videos", "upload", "uploads", "uploaded", "clip", "clips", "vid",
  "footage", "source", "sources", "file", "files", "another", "other",
  "mix", "mixing", "combine", "combining", "combined", "montage",
  "interleave", "interleaved", "alternate", "alternating", "shuffle",
  "shuffled", "shuffling", "order", "ordering", "arrange",
  "transition", "transitions", "fade", "fades", "crossfade", "glitch",
  "whip", "zoom", "cut", "cuts", "cinematic", "dynamic", "effect", "effects",
  "smooth", "hard", "fast", "slow",
  "scene", "scenes", "part", "parts", "moment", "moments", "bit", "bits",
  "section", "sections", "segment", "segments", "thing", "things", "stuff",
  "reel", "reels", "short", "shorts", "please", "pls"
]);

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

/** Extract the content topic tokens from a clause (stop/ordinal/number
 *  words removed). e.g. "pick combat in the first video" → ["combat"]. */
function extractTopicTokens(clause: string): string[] {
  const cleaned = clause
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b\d+\b/g, " ");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of cleaned.split(/\s+/)) {
    const t = w.trim();
    if (t.length < 2) continue;
    if (TOPIC_STOP.has(t)) continue;
    if (t in ORDINALS || t in NUMBER_WORDS) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.slice(0, 4);
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

function buildResult(
  sources: ComposeSourceSelection[],
  ordering: ComposeOrdering,
  transition: ComposeTransition,
  confidence: "high" | "low",
  picks: Array<{ index: number; baseTopic: string }>
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

  let message: string;
  if (picks.length >= 2) {
    const parts = picks.map(
      (p) => `${p.baseTopic} from the ${ORDINAL_NAMES[p.index] ?? `#${p.index + 1}`} video`
    );
    message = `Got it \u2014 I\u2019ll build ${name} with ${joinList(parts)}`;
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

  return {
    plan: {
      outputTarget: { type: "new_timeline_slot", name },
      sources,
      ordering,
      transition,
      needsAnalysis: true
    },
    message,
    confidence
  };
}

/**
 * Detect a multi-source compose intent from the user's text. Returns null
 * when the prompt is not clearly multi-source (the caller then proceeds
 * with the cloud planner / single-source fallback).
 */
export function deriveComposeIntent(
  userText: string
): ComposeIntentResult | null {
  const text = (userText || "").trim();
  if (!text) return null;
  const lower = text.toLowerCase();

  const hasShuffle = /\bshuffl/.test(lower);
  const hasMix = /\b(mix|mixing|alternat|interleav)/.test(lower);
  const hasCombine = /\bcombin/.test(lower);
  const hasMontage = /\bmontage\b/.test(lower);
  const ordering = detectOrdering(lower);
  const transition = detectTransition(lower);
  const anchorFirst =
    hasShuffle && /\bfirst\b/.test(lower) && /(then|after|rest)/.test(lower);

  // Parse clauses ("X in the first video" AND "Y in the second" AND …).
  const clauses = lower.split(/\band\b/);
  const picks: Array<{ index: number; baseTopic: string; query: string }> = [];
  const looseTopics: string[] = [];
  let sawSourceRef = false;
  for (const clause of clauses) {
    const idx = findSourceIndex(clause);
    if (idx !== null) sawSourceRef = true;
    const tokens = extractTopicTokens(clause);
    const base = tokens.join(" ");
    if (idx !== null && base) {
      picks.push({ index: idx, baseTopic: base, query: `${base} moments` });
    } else if (base) {
      looseTopics.push(base);
    }
  }

  const distinctIdx = new Set(picks.map((p) => p.index));
  const multiCue =
    sawSourceRef ||
    /\bvideos\b|\bclips\b|\buploads\b|\bthem\b|\bthe rest\b|\beach\b|\ball of them\b/.test(
      lower
    );

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
    return buildResult(sources, { type: ordering }, transition, "high", picks);
  }

  // ---- Tier B: mix/combine/montage trigger + ≥2 content topics
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
      topics.map((t, i) => ({ index: i, baseTopic: t }))
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
    return buildResult(sources, ord, transition, anchorFirst ? "high" : "low", []);
  }

  return null;
}

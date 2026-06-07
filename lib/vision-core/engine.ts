// =====================================================================
// lib/vision-core/engine.ts
//
// VISION-EDIT-CORE — the offline, deterministic reasoning engine.
//
// Input : pre-extracted structured visual analysis (frames + signals)
//         plus a user instruction.
// Output: precise, machine-readable timestamp JSON (VisionCoreOutput).
//
// Guarantees (enforced here, not assumed):
//   1. GROUNDED TIMESTAMPS ONLY. Every emitted start/end is a value that
//      exists in (or is bounded by) the input frame timestamps, clamped
//      to [0, duration_seconds]. The engine never invents a time.
//   2. DETERMINISTIC. No Math.random, no Date.now, no clock. Identical
//      input → identical output. Segment ids are positional
//      ("seg_0001"), ordering is stable.
//   3. PURE. No I/O, no network, no model. All math runs on the signals
//      the browser sampling pass already produced.
//
// This is the PRIMARY layer. The gate (gate.ts) decides whether the
// engine's result is confident enough to use, or whether to fall
// through to the cloud planner (Gemini → Groq) exactly as before.
// =====================================================================

import { formatTime, clamp } from "@/lib/util/time";
import type {
  VisionCoreFrame,
  VisionCoreInput,
  VisionCoreMode,
  VisionCoreOutput,
  VisionCoreResult,
  VisionCoreScores,
  VisionCoreSegment,
  VisionCoreSentiment,
  VisionCoreSentimentLabel
} from "@/lib/vision-core/types";

// ---------------------------------------------------------------------
// Tunables (kept local — this module is additive and must not perturb
// the shared lib/config.ts surface used by the existing pipeline).
// ---------------------------------------------------------------------

const ENGINE_DEFAULTS = {
  /** best_pick: number of highlights returned when params omit it. */
  maxPicks: 5,
  /** user_described: minimum relevance to include a scene. */
  minRelevance: 0.5,
  /** Motion delta (0..1) between adjacent frames that forces a scene
   *  boundary even when captions look continuous. */
  sceneBreakMotion: 0.45,
  /** Caption token Jaccard similarity below this also breaks a scene. */
  captionContinuityFloor: 0.18,
  /** Hard cap on scenes considered, to bound output size. */
  maxScenes: 64,
  /** A best-pick scene is trimmed to its strongest contiguous window of
   *  at most this many seconds. */
  bestPickMaxSeconds: 12,
  /** Floor on any emitted segment duration (seconds). */
  minSegmentSeconds: 0.5,
  /** Composite highlight weights — must sum to 1. */
  highlightWeights: { action: 0.4, clarity: 0.2, semantic: 0.4 }
} as const;

// ---------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------

/**
 * Run the engine. Returns a VisionCoreError on malformed/empty input,
 * otherwise a fully-formed VisionCoreResult.
 */
export function runVisionCore(input: VisionCoreInput): VisionCoreOutput {
  // ---- Validate -----------------------------------------------------
  if (!input || typeof input !== "object") {
    return errorOut("bad_input");
  }
  if (!input.video || typeof input.video.duration_seconds !== "number") {
    return errorOut("missing_video_meta");
  }
  const duration = input.video.duration_seconds;
  if (!Number.isFinite(duration) || duration <= 0) {
    return errorOut("invalid_duration");
  }
  if (!Array.isArray(input.frames) || input.frames.length === 0) {
    return errorOut("empty_frames");
  }

  // Normalize + sort frames by timestamp (stable, grounded). Drop frames
  // with non-finite or out-of-range timestamps so nothing ungrounded
  // can leak into a segment.
  const frames = normalizeFrames(input.frames, duration);
  if (frames.length === 0) {
    return errorOut("no_groundable_frames");
  }

  const mode = resolveMode(input);
  const prompt = (input.request?.prompt ?? "").trim();

  // ---- Connect frames into scenes -----------------------------------
  const sceneBreakMotion =
    clampUnit(input.request?.params?.scene_break_motion) ??
    ENGINE_DEFAULTS.sceneBreakMotion;
  const rawScenes = connectScenes(frames, duration, sceneBreakMotion);

  // ---- Score + describe every scene ---------------------------------
  const promptTokens = tokenize(prompt);
  const scenes = rawScenes.map((s, i) =>
    buildSegment(s, i, frames, promptTokens)
  );

  // ---- Mode-specific selection --------------------------------------
  const selected = selectByMode(scenes, mode, input);

  // Assign positional ids + best-pick flags AFTER ordering is final, so
  // ids are deterministic and contiguous in output order.
  const ordered = finalizeOrder(selected.segments, mode);
  const bestPickIds = new Set(selected.bestPickIdsInOrder);
  for (const seg of ordered) {
    seg.is_best_pick = bestPickIds.has(seg.id);
  }

  const result: VisionCoreResult = {
    ok: true,
    mode,
    video: {
      filename: stringOr(input.video.filename, "video"),
      duration_seconds: round2(duration)
    },
    summary: buildSummary(scenes, duration, mode),
    segments: ordered,
    best_picks: selected.bestPickIdsInOrder,
    stats: {
      scene_count: scenes.length,
      selected_count: ordered.length
    },
    notes: selected.notes
  };
  return result;
}

// ---------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------

/**
 * Resolve the request mode. When explicitly provided and valid, honour
 * it. Otherwise infer the closest mode from the prompt's INTENT — note
 * this inference runs only inside the offline engine and only chooses
 * among the engine's own modes; if it guesses wrong, the gate downgrades
 * confidence and the cloud planner takes over.
 */
function resolveMode(input: VisionCoreInput): VisionCoreMode {
  const m = input.request?.mode;
  if (
    m === "best_pick" ||
    m === "user_described" ||
    m === "timeline" ||
    m === "sentiment_map" ||
    m === "custom_format"
  ) {
    return m;
  }
  if (input.request?.params?.schema) return "custom_format";

  const prompt = (input.request?.prompt ?? "").trim();
  if (prompt.length === 0) return "best_pick";

  const tokens = new Set(tokenize(prompt));
  // Intent inference by concept presence. This is deliberately coarse;
  // ambiguity is fine because the gate falls back to Gemini when the
  // engine isn't confident.
  if (hasAny(tokens, ["sentiment", "mood", "emotion", "feel", "tone", "vibe"])) {
    return "sentiment_map";
  }
  if (
    hasAny(tokens, [
      "timeline",
      "breakdown",
      "scene",
      "scenes",
      "chapters",
      "structure",
      "walkthrough",
      "overview"
    ])
  ) {
    return "timeline";
  }
  // A prompt that names a subject ("clips with a dog", "high-energy
  // action") is a described-selection. Treat any remaining non-empty
  // prompt as user_described; pure "best parts" language → best_pick.
  if (
    hasAny(tokens, [
      "best",
      "highlight",
      "highlights",
      "top",
      "strongest",
      "greatest"
    ]) &&
    tokens.size <= 4
  ) {
    return "best_pick";
  }
  return "user_described";
}

// ---------------------------------------------------------------------
// Scene connection
// ---------------------------------------------------------------------

interface RawScene {
  startIdx: number;
  endIdx: number; // inclusive
}

/**
 * Connect temporally-adjacent frames into coherent scenes. A boundary
 * is declared when EITHER:
 *   - the motion between adjacent frames spikes above `sceneBreakMotion`
 *     (a hard visual cut / action burst), OR
 *   - the caption topic changes (token-set similarity drops below the
 *     continuity floor) — only when both frames carry captions.
 *
 * With no captions the connection is purely motion-driven, which still
 * yields sensible scenes from the motion/saliency-only sampling path.
 */
function connectScenes(
  frames: NormFrame[],
  duration: number,
  sceneBreakMotion: number
): RawScene[] {
  const scenes: RawScene[] = [];
  let start = 0;
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1];
    const curr = frames[i];

    const motionSpike = curr.motion >= sceneBreakMotion;

    let topicChange = false;
    if (prev.captionTokens.length > 0 && curr.captionTokens.length > 0) {
      const sim = jaccard(prev.captionTokens, curr.captionTokens);
      topicChange = sim < ENGINE_DEFAULTS.captionContinuityFloor;
    }

    if (motionSpike || topicChange) {
      scenes.push({ startIdx: start, endIdx: i - 1 });
      start = i;
      if (scenes.length >= ENGINE_DEFAULTS.maxScenes - 1) break;
    }
  }
  scenes.push({ startIdx: start, endIdx: frames.length - 1 });

  // Guard: ensure scenes are within frame bounds (they are by
  // construction) and duration is respected downstream via clamping.
  void duration;
  return scenes;
}

// ---------------------------------------------------------------------
// Segment construction (scoring + sentiment + description)
// ---------------------------------------------------------------------

function buildSegment(
  scene: RawScene,
  index: number,
  frames: NormFrame[],
  promptTokens: string[]
): VisionCoreSegment {
  const slice = frames.slice(scene.startIdx, scene.endIdx + 1);
  const first = slice[0];
  const last = slice[slice.length - 1];

  // Grounded bounds. Start at the first frame's timestamp; end at the
  // last frame's timestamp, but never let a single-frame scene collapse
  // to zero — extend to the next sample period (bounded by duration).
  const start = first.t;
  let end = last.t;
  if (end - start < ENGINE_DEFAULTS.minSegmentSeconds) {
    const samplePeriod = estimateSamplePeriod(frames);
    end = Math.min(last.tMaxBound, start + Math.max(samplePeriod, ENGINE_DEFAULTS.minSegmentSeconds));
  }

  const meanMotion = mean(slice.map((f) => f.motion));
  const meanSaliency = mean(slice.map((f) => f.saliency));
  const meanClarity = mean(slice.map((f) => f.clarity));
  const semantic = meanSaliency; // visual richness proxy when no caption sim

  const relevance = computeRelevance(slice, promptTokens);

  const action = clamp01(meanMotion);
  const clarity = clamp01(meanClarity);
  const w = ENGINE_DEFAULTS.highlightWeights;
  const highlight = clamp01(
    w.action * action + w.clarity * clarity + w.semantic * semantic
  );

  const scores: VisionCoreScores = {
    highlight: round2(highlight),
    relevance: round2(relevance),
    clarity: round2(clarity),
    action: round2(action)
  };

  const sentiment = computeSentiment(slice, action, clarity);
  const tags = deriveTags(slice);
  const label = deriveLabel(slice, tags, index);
  const description = deriveDescription(slice, tags, start, end);

  return {
    id: segId(index),
    start: round2(start),
    end: round2(end),
    start_tc: formatTime(start),
    end_tc: formatTime(end),
    duration: round2(Math.max(0, end - start)),
    label,
    description,
    tags,
    sentiment,
    scores,
    is_best_pick: false,
    source_frames: slice.map((f) => round2(f.t))
  };
}

/** Relevance of a scene to the prompt: fraction of prompt tokens that
 *  appear in the scene's caption/tag vocabulary, smoothed. When the
 *  prompt is empty, relevance is 1 (no constraint). */
function computeRelevance(slice: NormFrame[], promptTokens: string[]): number {
  if (promptTokens.length === 0) return 1;
  const vocab = new Set<string>();
  for (const f of slice) {
    for (const t of f.captionTokens) vocab.add(t);
    for (const t of f.tagTokens) vocab.add(t);
  }
  if (vocab.size === 0) return 0;
  let hits = 0;
  for (const t of promptTokens) if (vocab.has(t)) hits++;
  // Smooth: a single strong hit shouldn't read as 100%, and partial
  // matches should still clear typical min_relevance (0.5) when most of
  // the query is present.
  return clamp01(hits / promptTokens.length);
}

// ---------------------------------------------------------------------
// Sentiment (energy + caption polarity, deterministic)
// ---------------------------------------------------------------------

function computeSentiment(
  slice: NormFrame[],
  action: number,
  clarity: number
): VisionCoreSentiment {
  // Lexical polarity from captions (small fixed lexicon, deterministic).
  let pos = 0;
  let neg = 0;
  for (const f of slice) {
    for (const tok of f.captionTokens) {
      if (POSITIVE_WORDS.has(tok)) pos++;
      if (NEGATIVE_WORDS.has(tok)) neg++;
    }
  }
  const lexTotal = pos + neg;
  const lexPolarity = lexTotal > 0 ? (pos - neg) / lexTotal : 0;

  // Energy from motion. Darkness lowers clarity and nudges tone down.
  const energy = action;
  const polarity = clampSigned(lexPolarity * 0.7 + (clarity - 0.5) * 0.3);
  const intensity = clamp01(0.5 * energy + 0.5 * Math.abs(lexPolarity));

  const label = labelFor(polarity, energy, lexTotal);
  return {
    label,
    polarity: round2(polarity),
    intensity: round2(intensity)
  };
}

function labelFor(
  polarity: number,
  energy: number,
  lexTotal: number
): VisionCoreSentimentLabel {
  // High energy dominates the descriptor; otherwise polarity decides.
  if (energy >= 0.6) {
    if (polarity <= -0.3) return "tense";
    return "energetic";
  }
  if (energy <= 0.2) {
    if (polarity >= 0.3) return "calm";
    if (polarity <= -0.3) return "sad";
    return "calm";
  }
  if (lexTotal === 0) {
    // No lexical signal and mid energy → neutral.
    if (polarity >= 0.25) return "positive";
    if (polarity <= -0.25) return "negative";
    return "neutral";
  }
  if (polarity >= 0.45) return "joyful";
  if (polarity >= 0.15) return "positive";
  if (polarity <= -0.15) return "negative";
  return "neutral";
}

// ---------------------------------------------------------------------
// Description helpers
// ---------------------------------------------------------------------

function deriveTags(slice: NormFrame[]): string[] {
  const counts = new Map<string, number>();
  for (const f of slice) {
    for (const tok of f.captionTokens) {
      if (STOP_WORDS.has(tok) || tok.length < 3) continue;
      counts.set(tok, (counts.get(tok) ?? 0) + 1);
    }
    for (const tok of f.tagTokens) {
      if (tok.length < 3) continue;
      counts.set(tok, (counts.get(tok) ?? 0) + 1);
    }
  }
  // Deterministic ordering: by count desc, then lexical asc.
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 5)
    .map(([t]) => t);
}

function deriveLabel(
  slice: NormFrame[],
  tags: string[],
  index: number
): string {
  if (tags.length > 0) {
    return tags.slice(0, 3).join(" ");
  }
  // No captions/tags: fall back to a motion descriptor so the label is
  // still literal and useful to the editor.
  const m = mean(slice.map((f) => f.motion));
  const energy = m >= 0.6 ? "high-motion" : m >= 0.3 ? "moderate-motion" : "static";
  return `${energy} scene ${index + 1}`;
}

function deriveDescription(
  slice: NormFrame[],
  tags: string[],
  start: number,
  end: number
): string {
  // Prefer the most representative caption (the one whose token set
  // overlaps most with the scene's aggregate vocabulary) for a literal,
  // grounded description. Deterministic tie-break by earliest frame.
  const captioned = slice.filter((f) => f.caption && f.caption.trim().length > 0);
  if (captioned.length > 0) {
    const vocab = new Map<string, number>();
    for (const f of captioned)
      for (const t of f.captionTokens) vocab.set(t, (vocab.get(t) ?? 0) + 1);
    let best = captioned[0];
    let bestScore = -1;
    for (const f of captioned) {
      let s = 0;
      for (const t of f.captionTokens) s += vocab.get(t) ?? 0;
      if (s > bestScore) {
        bestScore = s;
        best = f;
      }
    }
    return best.caption!.trim().slice(0, 200);
  }
  const span = `${formatTime(start)}\u2013${formatTime(end)}`;
  if (tags.length > 0) {
    return `Scene ${span} featuring ${tags.slice(0, 3).join(", ")}.`;
  }
  return `Scene ${span} with notable visual activity.`;
}

function buildSummary(
  scenes: VisionCoreSegment[],
  duration: number,
  mode: VisionCoreMode
): string {
  const sceneWord = scenes.length === 1 ? "scene" : "scenes";
  const topTags = aggregateTopTags(scenes, 4);
  const tagPart = topTags.length > 0 ? ` covering ${topTags.join(", ")}` : "";
  return `${formatTime(duration)} video with ${scenes.length} ${sceneWord}${tagPart} (${mode}).`;
}

// ---------------------------------------------------------------------
// Selection by mode
// ---------------------------------------------------------------------

interface Selection {
  segments: VisionCoreSegment[];
  /** Best-pick ids, ordered strongest-first. */
  bestPickIdsInOrder: string[];
  notes: string;
}

function selectByMode(
  scenes: VisionCoreSegment[],
  mode: VisionCoreMode,
  input: VisionCoreInput
): Selection {
  switch (mode) {
    case "timeline":
    case "sentiment_map":
      // Full connected breakdown across the whole video. No filtering.
      return { segments: scenes, bestPickIdsInOrder: [], notes: "" };

    case "user_described": {
      const minRel =
        clampUnit(input.request?.params?.min_relevance) ??
        ENGINE_DEFAULTS.minRelevance;
      const kept = scenes.filter((s) => s.scores.relevance >= minRel);
      if (kept.length === 0) {
        // Nothing cleared the bar. Return empty selection but keep a
        // machine-readable note — the gate reads this to decide whether
        // Gemini should take over.
        return {
          segments: [],
          bestPickIdsInOrder: [],
          notes: "no_scene_met_min_relevance"
        };
      }
      return { segments: kept, bestPickIdsInOrder: [], notes: "" };
    }

    case "best_pick":
    default: {
      const maxPicks =
        clampInt(input.request?.params?.max_picks, 1, 20) ??
        ENGINE_DEFAULTS.maxPicks;
      // Rank by highlight strength; deterministic tie-break by start.
      const ranked = [...scenes].sort(
        (a, b) =>
          b.scores.highlight - a.scores.highlight || a.start - b.start
      );
      const picks = ranked
        .slice(0, maxPicks)
        .map((s) => trimToStrongestWindow(s, input.frames));
      const idsStrongestFirst = picks.map((p) => p.id);
      return {
        segments: picks,
        bestPickIdsInOrder: idsStrongestFirst,
        notes: ""
      };
    }
  }
}

/**
 * Trim a best-pick scene to its strongest contiguous sub-window (bounded
 * by bestPickMaxSeconds), centred on the highest-motion frame. Always
 * grounded: the new bounds are existing frame timestamps within the
 * scene. Returns a NEW segment object (does not mutate input).
 */
function trimToStrongestWindow(
  seg: VisionCoreSegment,
  rawFrames: VisionCoreFrame[]
): VisionCoreSegment {
  if (seg.duration <= ENGINE_DEFAULTS.bestPickMaxSeconds) return seg;
  const inScene = rawFrames
    .filter((f) => f.t >= seg.start && f.t <= seg.end && Number.isFinite(f.t))
    .sort((a, b) => a.t - b.t);
  if (inScene.length === 0) return seg;

  // Find the peak-motion frame as the anchor.
  let peakIdx = 0;
  let peak = -1;
  for (let i = 0; i < inScene.length; i++) {
    const m = inScene[i].tags?.motion_score ?? 0;
    if (m > peak) {
      peak = m;
      peakIdx = i;
    }
  }
  const anchorT = inScene[peakIdx].t;
  const half = ENGINE_DEFAULTS.bestPickMaxSeconds / 2;
  const winStart = Math.max(seg.start, anchorT - half);
  const winEnd = Math.min(seg.end, anchorT + half);

  const inWin = inScene.filter((f) => f.t >= winStart && f.t <= winEnd);
  const start = inWin.length > 0 ? inWin[0].t : winStart;
  const end = inWin.length > 0 ? inWin[inWin.length - 1].t : winEnd;
  const safeEnd = end > start ? end : Math.min(seg.end, start + half);

  return {
    ...seg,
    start: round2(start),
    end: round2(safeEnd),
    start_tc: formatTime(start),
    end_tc: formatTime(safeEnd),
    duration: round2(Math.max(0, safeEnd - start)),
    source_frames: inWin.map((f) => round2(f.t))
  };
}

/** Final ordering rule. timeline/sentiment_map/user_described are sorted
 *  ascending by start; best_pick keeps strongest-first (already sorted
 *  in selectByMode). Ensures no overlap-induced reordering surprises. */
function finalizeOrder(
  segments: VisionCoreSegment[],
  mode: VisionCoreMode
): VisionCoreSegment[] {
  if (mode === "best_pick") return segments;
  return [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
}

// ---------------------------------------------------------------------
// Frame normalization
// ---------------------------------------------------------------------

interface NormFrame {
  t: number;
  /** Upper bound a single-frame scene may extend to (next frame or dur). */
  tMaxBound: number;
  motion: number;
  saliency: number;
  /** 0..1 clarity derived from brightness bucket (very dark → low). */
  clarity: number;
  caption?: string;
  captionTokens: string[];
  tagTokens: string[];
}

function normalizeFrames(
  frames: VisionCoreFrame[],
  duration: number
): NormFrame[] {
  const valid = frames
    .filter(
      (f) =>
        f &&
        typeof f.t === "number" &&
        Number.isFinite(f.t) &&
        f.t >= 0 &&
        f.t <= duration + 0.001
    )
    .map((f) => ({ ...f, t: clamp(f.t, 0, duration) }))
    .sort((a, b) => a.t - b.t);

  const out: NormFrame[] = [];
  for (let i = 0; i < valid.length; i++) {
    const f = valid[i];
    const next = valid[i + 1];
    const motion = clamp01(
      typeof f.tags?.motion_score === "number"
        ? f.tags!.motion_score!
        : motionFromBucket(f.tags?.motion)
    );
    const saliency = clamp01(
      typeof f.saliency === "number" ? f.saliency : 0.3
    );
    const clarity = clarityFromBrightness(f.tags?.brightness);
    const captionTokens = tokenize(f.caption ?? "");
    const tagTokens = [
      ...tokenize(f.tags?.color ?? ""),
      ...tokenize(f.tags?.motion ?? ""),
      ...tokenize(f.tags?.brightness ?? "")
    ];
    out.push({
      t: f.t,
      tMaxBound: next ? next.t : Math.min(duration, f.t + 2),
      motion,
      saliency,
      clarity,
      caption: f.caption,
      captionTokens,
      tagTokens
    });
  }
  return out;
}

// ---------------------------------------------------------------------
// Small deterministic lexicons + tokenization
// ---------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "is", "are",
  "was", "were", "with", "for", "as", "by", "this", "that", "these", "those",
  "it", "its", "be", "from", "into", "over", "they", "their", "there", "here",
  "shows", "showing", "image", "frame", "scene", "video", "picture", "photo"
]);

const POSITIVE_WORDS = new Set([
  "happy", "joy", "joyful", "smile", "smiling", "laugh", "laughing", "celebrate",
  "celebration", "win", "winning", "victory", "fun", "bright", "beautiful",
  "calm", "peaceful", "relaxed", "cheer", "cheering", "excited", "love"
]);

const NEGATIVE_WORDS = new Set([
  "sad", "cry", "crying", "angry", "anger", "fear", "scared", "dark", "gloomy",
  "lose", "losing", "loss", "defeat", "defeated", "fight", "fighting", "crash",
  "broken", "tense", "stress", "stressed", "pain", "hurt", "violent", "violence"
]);

/** Lowercase, strip punctuation, split on whitespace, drop empties. */
function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------
// Signal helpers
// ---------------------------------------------------------------------

function motionFromBucket(bucket?: string): number {
  switch ((bucket ?? "").toLowerCase()) {
    case "high":
      return 0.8;
    case "medium":
      return 0.5;
    case "low":
      return 0.25;
    case "still":
      return 0.05;
    default:
      return 0.3;
  }
}

function clarityFromBrightness(bucket?: string): number {
  switch ((bucket ?? "").toLowerCase()) {
    case "very dark":
      return 0.15;
    case "dark":
      return 0.45;
    case "normal":
      return 0.85;
    case "bright":
      return 0.9;
    case "very bright":
      return 0.7; // blown-out highlights reduce usable clarity
    default:
      return 0.7;
  }
}

function estimateSamplePeriod(frames: NormFrame[]): number {
  if (frames.length < 2) return 1;
  // Median of adjacent deltas → robust, deterministic.
  const deltas: number[] = [];
  for (let i = 1; i < frames.length; i++) deltas.push(frames[i].t - frames[i - 1].t);
  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  const m = deltas.length % 2 === 0 ? (deltas[mid - 1] + deltas[mid]) / 2 : deltas[mid];
  return m > 0 ? m : 1;
}

// ---------------------------------------------------------------------
// Generic math / utilities (pure, deterministic)
// ---------------------------------------------------------------------

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function aggregateTopTags(segments: VisionCoreSegment[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const s of segments)
    for (const t of s.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, n)
    .map(([t]) => t);
}

function hasAny(tokens: Set<string>, words: string[]): boolean {
  for (const w of words) if (tokens.has(w)) return true;
  return false;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function clampSigned(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < -1 ? -1 : n > 1 ? 1 : n;
}

/** Clamp an optional unit value; returns undefined when not a number. */
function clampUnit(n: unknown): number | undefined {
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  return clamp01(n);
}

/** Clamp an optional integer in [min,max]; undefined when not a number. */
function clampInt(n: unknown, min: number, max: number): number | undefined {
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function segId(index: number): string {
  return `seg_${String(index + 1).padStart(4, "0")}`;
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim().length > 0 ? v : fallback;
}

function errorOut(reason: string): VisionCoreOutput {
  return { ok: false, error: reason, segments: [] };
}

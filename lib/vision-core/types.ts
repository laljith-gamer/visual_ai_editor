// =====================================================================
// lib/vision-core/types.ts
//
// Type contract for VISION-EDIT-CORE — the offline, deterministic
// reasoning engine that runs PRIMARY (before any cloud LLM call) and
// converts pre-extracted structured visual analysis + a user
// instruction into precise, machine-readable timestamp JSON.
//
// Design rules mirrored from the engine spec:
//   - Every emitted time value is GROUNDED in the input frames; the
//     engine never invents timestamps.
//   - Output is deterministic: identical input → identical output.
//   - All times are SECONDS (float) AND a formatted "MM:SS"/"HH:MM:SS"
//     timecode string.
//
// This module is PURE TYPES only — no runtime, no imports from the
// pipeline. The engine (engine.ts) and the EditPlan adapter (adapt.ts)
// consume these. Nothing here changes existing planner/provider logic.
// =====================================================================

// ---------------------------------------------------------------------
// INPUT CONTRACT
// ---------------------------------------------------------------------

/** Lightweight per-frame visual signals. All scores are 0..1 unless
 *  noted. These mirror what the in-browser sampling pass already
 *  produces (motion / saliency) plus optional caption / tag metadata
 *  when a captioning stage is available. */
export interface VisionCoreFrameTags {
  /** Coarse brightness bucket. Free-text but typically
   *  "very dark" | "dark" | "normal" | "bright" | "very bright". */
  brightness?: string;
  /** Coarse motion bucket. Typically "still" | "low" | "medium" | "high". */
  motion?: string;
  /** Raw motion score 0..1 (frame-to-frame pixel difference). */
  motion_score?: number;
  /** Dominant color descriptor, free-text ("warm", "blue", "green"…). */
  color?: string;
}

/** One analyzed frame. `t` is the grounding timestamp in seconds. */
export interface VisionCoreFrame {
  /** Timestamp in seconds. The only source of truth for grounding. */
  t: number;
  /** Optional natural-language caption for the frame. May be empty
   *  when no captioning stage ran (motion/saliency-only path). */
  caption?: string;
  /** Optional lightweight visual signals. */
  tags?: VisionCoreFrameTags;
  /** Optional histogram-entropy saliency 0..1 (when available from the
   *  sampling pass). Not part of the public spec but accepted so the
   *  engine can reuse the signal the pipeline already computes. */
  saliency?: number;
}

/** Optional hierarchical temporal summary. Accepted but not required;
 *  the engine connects frames directly when absent. Kept loose on
 *  purpose so upstream summarizers can evolve their shape. */
export interface VisionCoreTree {
  levels?: Record<string, unknown>;
  root?: Record<string, unknown>;
}

/** Video metadata. `duration_seconds` bounds every clamp. */
export interface VisionCoreVideo {
  filename: string;
  duration_seconds: number;
  /** Sampling rate used to extract `frames` (frames per second). */
  fps_sampled?: number;
}

/** Supported request modes. When `mode` is absent the engine infers the
 *  closest mode from `prompt`. */
export type VisionCoreMode =
  | "best_pick"
  | "user_described"
  | "timeline"
  | "sentiment_map"
  | "custom_format";

/** Tunable params per request. All optional with documented defaults
 *  applied inside the engine. */
export interface VisionCoreParams {
  /** best_pick: number of highlights to return. Default 5. */
  max_picks?: number;
  /** user_described: minimum relevance to include a scene. Default 0.5. */
  min_relevance?: number;
  /** custom_format: explicit output shape the caller wants echoed back. */
  schema?: Record<string, unknown>;
  /** Optional override of the scene-boundary motion-spike sensitivity
   *  (0..1). Higher = fewer, longer scenes. */
  scene_break_motion?: number;
}

/** The user's editing intent. */
export interface VisionCoreRequest {
  mode?: VisionCoreMode;
  prompt?: string;
  params?: VisionCoreParams;
}

/** Full input object handed to the engine. */
export interface VisionCoreInput {
  video: VisionCoreVideo;
  frames: VisionCoreFrame[];
  tree?: VisionCoreTree;
  request: VisionCoreRequest;
}

// ---------------------------------------------------------------------
// OUTPUT SCHEMA
// ---------------------------------------------------------------------

/** Sentiment label taxonomy fixed by the spec. */
export type VisionCoreSentimentLabel =
  | "positive"
  | "negative"
  | "neutral"
  | "tense"
  | "energetic"
  | "calm"
  | "sad"
  | "joyful";

export interface VisionCoreSentiment {
  label: VisionCoreSentimentLabel;
  /** Polarity in [-1, 1]. */
  polarity: number;
  /** Intensity in [0, 1]. */
  intensity: number;
}

/** Per-scene score breakdown. All 0..1. */
export interface VisionCoreScores {
  /** Overall highlight strength used for ranking / best_pick. */
  highlight: number;
  /** Relevance to request.prompt (1 when no prompt constraint). */
  relevance: number;
  /** Visual clarity (penalized by "very dark" / flat frames). */
  clarity: number;
  /** Visual change / action (driven by motion). */
  action: number;
}

/** A connected scene, grounded entirely in input frame timestamps. */
export interface VisionCoreSegment {
  /** Stable, deterministic id ("seg_0001", "seg_0002", …). */
  id: string;
  /** Start time in seconds (float). */
  start: number;
  /** End time in seconds (float). Always > start. */
  end: number;
  /** Formatted start timecode "MM:SS" or "HH:MM:SS". */
  start_tc: string;
  /** Formatted end timecode. */
  end_tc: string;
  /** end - start, in seconds. */
  duration: number;
  /** Short scene title (2-5 words). */
  label: string;
  /** One connected sentence describing the scene. */
  description: string;
  /** Salient tags distilled from captions/colors. */
  tags: string[];
  sentiment: VisionCoreSentiment;
  scores: VisionCoreScores;
  /** True when this scene is among the ranked best picks. */
  is_best_pick: boolean;
  /** Input timestamps this scene was connected from. */
  source_frames: number[];
}

export interface VisionCoreStats {
  scene_count: number;
  selected_count: number;
}

/** Successful engine result (the canonical VISION-EDIT-CORE envelope). */
export interface VisionCoreResult {
  ok: true;
  mode: VisionCoreMode;
  video: { filename: string; duration_seconds: number };
  /** One-sentence machine-usable description of the whole video. */
  summary: string;
  segments: VisionCoreSegment[];
  /** Segment ids ordered strongest-first; [] when not applicable. */
  best_picks: string[];
  stats: VisionCoreStats;
  /** Empty string unless a non-fatal caveat applies. */
  notes: string;
}

/** Error envelope returned on malformed / empty / ungroundable input. */
export interface VisionCoreError {
  ok: false;
  /** Short machine-readable reason ("empty_frames", "bad_input", …). */
  error: string;
  segments: [];
}

/** Discriminated union the engine returns. Callers branch on `ok`. */
export type VisionCoreOutput = VisionCoreResult | VisionCoreError;

// ---------------------------------------------------------------------
// CUSTOM FORMAT
// ---------------------------------------------------------------------

/** When request.mode === "custom_format" and params.schema is provided,
 *  the engine echoes a result conforming to that schema. Because the
 *  shape is caller-defined we keep it as an opaque record but still
 *  guarantee `ok` for branch consistency. */
export interface VisionCoreCustomResult {
  ok: true;
  mode: "custom_format";
  [key: string]: unknown;
}

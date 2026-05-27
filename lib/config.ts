// =====================================================================
// lib/config.ts — single source of truth for every tunable in the app.
//
// Rule: NO magic numbers in pipeline code. If a number drives behaviour,
// it lives here with a name and a comment. The planner can override
// per-request via the EditPlan it returns; these are the defaults the
// planner falls back to when *it* didn't specify something.
// =====================================================================

/** Sampling defaults the planner can override per-plan. */
export const SAMPLE_DEFAULTS = {
  /** Period between sampled frames, in seconds. */
  everySeconds: 1.0,
  /** Target thumbnail width in pixels. Height preserves aspect. */
  width: 256,
  /** JPEG quality used for sampled-frame encoding (0..1). */
  jpegQuality: 0.82,
  /** Hard cap on number of frames per sampling pass. */
  maxFrames: 240
} as const;

/** Cloud per-frame fallback (mobile / WebGPU-less devices). */
export const CLOUD_FRAME = {
  /** How many frames are bundled into a single /api/vision/frame call. */
  batchSize: 8
} as const;

/** Contact-sheet temporal pass dimensions. */
export const CONTACT_SHEET = {
  cols: 4,
  rows: 3,
  /** Width of each cell in pixels; height follows source aspect. */
  cellWidth: 256,
  /** Number of frames sampled inside each candidate window. */
  framesPerWindow: 12,
  /** Minimum dense-sample period during the temporal pass. */
  minDenseSampleSeconds: 0.2,
  /** Output JPEG quality for the assembled sheet. */
  jpegQuality: 0.82
} as const;

/** Candidate-window detection (lib/pipeline/events.ts). */
export const EVENT_DETECTION = {
  /** threshold = mean(scores) + N * stddev(scores) */
  thresholdStddevMultiplier: 0.5,
  /** Absolute floor below which we never accept a frame as "interesting". */
  thresholdFloor: 0.15,
  /** Frames within this many sample-periods are treated as one window. */
  gapToleranceSamplePeriods: 2.5,
  /** Minimum window duration as a fraction of plan.minClipSeconds. */
  minDurationFractionOfMinClip: 0.6
} as const;

/** Highlight selection scoring (lib/pipeline/highlights.ts). */
export const HIGHLIGHT_SCORING = {
  /** Composite score weights — must sum to 1.0. */
  weights: {
    perFrameMean: 0.55,
    temporalKeep: 0.30,
    lengthBonus: 0.15
  },
  /** Default keep-score when a temporal verdict is missing. */
  neutralKeepScore: 0.5,
  /** "Balanced" selection: minimum bucket count for spread. */
  minDesiredClipCount: 3,
  /** "Balanced" selection: minimum seconds per bucket. */
  minBucketSeconds: 2,
  /** "Balanced" selection: maximum round-robin passes before giving up. */
  maxSelectionRounds: 4
} as const;

/** Default plan values used when the planner returned a partial plan AND
 *  no inference / memory could fill the gap. The planner is REQUIRED to
 *  emit explicit values for at least scenarios — if those are missing
 *  we go to CLARIFY mode rather than substituting. */
export const PLAN_DEFAULTS = {
  targetShortSeconds: 30,
  maxClipSeconds: 8,
  minClipSeconds: 1.5,
  format: "vertical" as const,
  transition: "fade" as const,
  selectionStrategy: "balanced" as const,
  sampleEverySeconds: SAMPLE_DEFAULTS.everySeconds,
  inferenceWidth: SAMPLE_DEFAULTS.width
} as const;

/** Plan validation bounds. */
export const PLAN_BOUNDS = {
  targetShortSeconds: { min: 5, max: 600 },
  maxClipSeconds: { min: 1, max: 60 },
  minClipSeconds: { min: 0.5, max: 30 },
  sampleEverySeconds: { min: 0.25, max: 10 },
  inferenceWidth: { min: 128, max: 768 },
  scenarioCount: { min: 1, max: 6 },
  styleCount: { min: 0, max: 8 },
  scenarioWeight: { min: 0, max: 5 }
} as const;

/** Inference heuristics (lib/plan/intent.ts). */
export const INFERENCE_HEURISTICS = {
  /** Aspect ratio cutoff: width/height < this → portrait. */
  portraitAspectMax: 0.95,
  /** Aspect ratio cutoff: width/height > this → landscape. */
  landscapeAspectMin: 1.4,

  /** Source-duration → target buckets. */
  sourceLength: {
    veryShortMaxSeconds: 60,
    shortMaxSeconds: 5 * 60,
    longMinSeconds: 30 * 60
  },

  /** Target seconds chosen by source length when user didn't say. */
  inferredTarget: {
    veryShortFractionOfSource: 0.4,
    veryShortHardCap: 30,
    short: 30,
    medium: 45,
    long: 60
  },

  /** Keyword → format / pacing hints. */
  keywords: {
    vertical: ["tiktok", "reel", "reels", "shorts", "youtube short", "instagram"],
    horizontal: ["youtube long", "long form", "long-form", "presentation", "lecture", "webinar"],
    square: ["instagram feed", "linkedin"],
    sports: ["sports", "highlight", "highlights", "action", "goal", "dunk", "score", "match", "game", "play"],
    talking: ["podcast", "interview", "talking head", "lecture", "talk", "speech", "vlog"]
  },

  /** Pacing applied when sports keywords matched. */
  sportsOverrides: {
    maxClipSeconds: 6,
    sampleEverySeconds: 0.5
  },
  /** Pacing applied when talking-head keywords matched. */
  talkingOverrides: {
    maxClipSeconds: 12,
    sampleEverySeconds: 2.0
  }
} as const;

/** Moment-retrieval pipeline (lib/pipeline/moment.ts). */
export const MOMENT_RETRIEVAL = {
  /** Width of expanded window around the peak frame, in seconds. */
  windowExpandSeconds: 4.0,
  /** Maximum total clip duration allowed (clamps very long peaks). */
  maxClipSeconds: 12,
  /** Padding added before/after the verified peak. */
  edgePaddingSeconds: 0.5,
  /** Minimum clip duration. */
  minClipSeconds: 1.0
} as const;

/** Conversation history sent to the planner. */
export const CONVERSATION = {
  /** Most recent N user/assistant pairs included in planner context. */
  maxHistoryTurns: 8,
  /** Hard cap on per-message length for the prompt. */
  maxMessageChars: 1200,
  /** User prompt size validation in /api/agent. */
  maxUserRequestChars: 4000
} as const;

/** Initial assistant greeting. */
export const GREETINGS = {
  initial:
    "Hey — I'm your editor. Drop a video into the rail, then tell me what kind of short you want. I'll plan the cuts, score every frame, and assemble the highlight reel."
} as const;

/** Render worker (lib/pipeline/render.worker.ts). Centralised here for
 *  easy retargeting if a Vercel Pro / cloud render path is added later. */
export const RENDER = {
  /** ffmpeg.wasm core CDN base URL. */
  ffmpegCoreBaseUrl: "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd",
  /** Output frame rate. */
  fps: 30,
  /** Constant Rate Factor for libx264. */
  crf: 23,
  /** ffmpeg preset. */
  preset: "veryfast",
  /** Audio bitrate. */
  audioBitrate: "128k",
  /** Maximum fade duration as a fraction of clip length. */
  fadeFractionOfClip: 0.25,
  /** Hard cap on fade duration. */
  fadeMaxSeconds: 0.4,
  outputDimensions: {
    vertical: { w: 1080, h: 1920 },
    horizontal: { w: 1920, h: 1080 },
    square: { w: 1080, h: 1080 }
  }
} as const;

/** Predictions cache trim policy. */
export const CACHE = {
  maxEntries: 50
} as const;

/** Capability detection (hooks/useCapability.ts). */
export const CAPABILITY = {
  /** Device memory threshold for "high" tier in GB. */
  highTierMinDeviceMemoryGB: 4,
  /** Hardware concurrency threshold for "mid" tier. */
  midTierMinHardwareConcurrency: 4
} as const;

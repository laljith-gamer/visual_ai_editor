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
  maxFrames: 240,
  /** mediabunny CanvasSink fit mode. Required when both w+h are passed. */
  fit: "fill" as const
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

/** Candidate-window detection (lib/pipeline/events.ts).
 *  All score thresholds are now adaptive — see ADAPT below. These are
 *  only the structural knobs for grouping frames into windows. */
export const EVENT_DETECTION = {
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

// =====================================================================
// v1.2.0 additions — activity log + multi-layer rate limit
// =====================================================================

/** Activity log behaviour (lib/log/*). */
export const ACTIVITY = {
  /** Max events kept per session in IndexedDB. Oldest are trimmed first. */
  maxEventsPerSession: 2000,
  /** Identical consecutive events within this window collapse into one with a `count`. */
  dedupeWindowMs: 1500,
  /** How many recent events get summarised into the planner prompt. */
  recentForPlanner: 12,
  /** Older than this is treated as irrelevant for planner context. */
  recentMaxAgeMs: 30 * 60 * 1000,
  /** Debounce IndexedDB writes by this much for performance. */
  flushIntervalMs: 250,
  /** When this many user actions fire without a render, we lower-priority them in summaries. */
  noisyEventCap: 25
} as const;

/** Multi-layer rate limit configuration (lib/ratelimit/*). */
export const RATE_LIMITS = {
  /** Layer 1 — IP-based throttle, applied at the edge (middleware). */
  ip: {
    /** Global cap for any /api/* request. */
    api: { limit: 60, windowSeconds: 60 },
    /** Stricter cap for the LLM-cost endpoint. */
    agent: { limit: 15, windowSeconds: 60 }
  },
  /** Layer 2 — session-cookie buckets (per-user). Burst + daily ceiling. */
  session: {
    agent: { burstLimit: 30, burstWindowSeconds: 60, dailyLimit: 200 },
    visionWindow: { burstLimit: 30, burstWindowSeconds: 60, dailyLimit: 300 },
    visionFrame: { burstLimit: 20, burstWindowSeconds: 60, dailyLimit: 200 }
  },
  /** Layer 3 — global daily LLM budget guard. */
  global: {
    /** Total provider calls allowed per UTC day across ALL users.
     *  Set below the actual provider quota to leave a safety margin. */
    geminiDailyBudget: 200,
    /** Tighten per-session limits at this fraction consumed. */
    softThreshold: 0.7,
    /** Reject new agent requests at this fraction consumed. */
    hardThreshold: 0.95
  },
  /** Layer 4 — circuit breaker per provider. */
  circuitBreaker: {
    failureThreshold: 5,
    failureWindowMs: 60 * 1000,
    cooldownMs: 120 * 1000
  },
  /** Punishment tier for sessions that repeatedly hit limits. */
  punish: {
    /** Triggers strict tier after this many rate-limit hits in a day. */
    maxHitsBeforeStrict: 5,
    /** Reduced burst limit while in strict tier. */
    strictBurstLimit: 1,
    strictBurstWindowSeconds: 60
  }
} as const;

/** Security headers applied by middleware on every response. */
export const SECURITY_HEADERS = {
  /** CSP must allow wasm + CDN scripts for ffmpeg + transformers. */
  contentSecurityPolicy:
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://cdn.jsdelivr.net; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob: https:; " +
    "font-src 'self' data:; " +
    "media-src 'self' blob:; " +
    "connect-src 'self' https://*.googleapis.com https://*.groq.com https://huggingface.co https://*.huggingface.co https://unpkg.com https://cdn.jsdelivr.net; " +
    "worker-src 'self' blob:; " +
    "frame-ancestors 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self'",
  permissionsPolicy: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  referrerPolicy: "strict-origin-when-cross-origin",
  hsts: "max-age=31536000; includeSubDomains",
  xFrameOptions: "DENY",
  xContentTypeOptions: "nosniff"
} as const;



/** v1.5.0 — default signal-fusion weights. The planner emits
 *  per-turn `signals` overrides; these only kick in when the LLM
 *  forgets to specify or the user is on an old session.
 *
 *  Three preset profiles guide the LLM in the prompt:
 *    - SCENARIO_HEAVY: user described concrete visual targets
 *    - BALANCED:       user gave a topic but no clear visual cue
 *    - VISUAL_INTEREST: user said "best part" / "interesting bits" /
 *                      time-bounded "pick best of X" with no scenarios
 */
export const SIGNAL_DEFAULTS = {
  /** Used when scenarios are present and concrete. */
  scenarioHeavy: { semantic: 0.7, motion: 0.2, saliency: 0.1 },
  /** Used when scenarios exist but are abstract. */
  balanced: { semantic: 0.5, motion: 0.3, saliency: 0.2 },
  /** Used when no scenarios — pure visual-interest scoring.
   *  semantic: 0 → SigLIP is skipped entirely (huge speedup). */
  visualInterest: { semantic: 0, motion: 0.6, saliency: 0.4 },
  /** Boost factor applied to motion before clamping. Raw frame-diff
   *  values rarely exceed 0.25 even on action shots, so we expand the
   *  dynamic range so motion is comparable to semantic on its scale. */
  motionGain: 4,
  /** Stride (in pixels) for motion + saliency sampling. Lower = more
   *  accurate, slower. 4 means we sample 1/16th of pixels. */
  pixelStride: 4
} as const;

export const ADAPT = {
  /** Candidate-percentile defaults (top-X% of frames by score). */
  percentile: {
    /** Default for novice + balanced strategy. Wide net, always returns something. */
    novice: 0.30,
    /** Slightly stricter for advanced users — they want precision. */
    advanced: 0.20,
    /** Stricter still for "best" selection strategy. */
    bestStrategy: 0.15,
    /** When max - mean < this, the score distribution is flat → widen percentile. */
    flatRangeThreshold: 0.05,
    /** How much to widen by when flat. */
    flatBoost: 0.10,
    /** Hard cap on widening. */
    maxWidened: 0.50
  },
  /** Min clip duration derivation. */
  minClipSeconds: {
    /** Lowest minClip allowed regardless of inputs. */
    absoluteFloor: 0.5,
    /** Highest derived minClip cap. */
    absoluteCeiling: 2.5,
    /** Adaptive cap = sourceDuration / sourceDivisor (clamped to floor/ceiling). */
    sourceDivisor: 60,
    /** Multiply derived minClip by this for novice tier. */
    noviceFactor: 0.7
  },
  /** Force-min highlights: how many clips MUST come back. */
  forceMin: {
    novice: 1,
    advanced: 0
  },
  /** Score → confidence label thresholds. */
  confidence: {
    highMin: 0.5,
    mediumMin: 0.25
  }
} as const;

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
  /** v1.7.1 — SOFT, NON-ENFORCED fallback only. The pipeline NEVER fits to
   *  this number unless `EditPlan.userSpecifiedDuration === true` (i.e. the
   *  user explicitly named a length). When the user did NOT name a duration,
   *  selection runs the quality-floor path and total length is emergent —
   *  this value is just a placeholder the schema still requires. Do not
   *  surface it as "30s" in the UI or assistant copy for no-duration plans. */
  targetShortSeconds: 30,
  maxClipSeconds: 8,
  minClipSeconds: 1.5,
  format: "vertical" as const,
  transition: "fade" as const,
  selectionStrategy: "balanced" as const,
  sampleEverySeconds: SAMPLE_DEFAULTS.everySeconds,
  inferenceWidth: SAMPLE_DEFAULTS.width,
  /** v1.7.1 — score threshold below which a clip is dropped when the
   *  pipeline runs in quality-floor mode (userSpecifiedDuration =
   *  false).
   *
   *  v1.7.2 — calibration update: lowered from 0.55 to 0.40 because
   *  real-world SigLIP+motion+saliency fusion scores on legitimately
   *  matching footage typically land in the 0.45-0.65 range; a 0.55
   *  floor was rejecting genuine matches and dropping the runs to a
   *  single weak clip via the forceMin fallback. With 0.40 the floor
   *  catches most relevant content and the new progressive-fallback
   *  in highlights.ts handles the long tail. */
  qualityFloor: 0.4,
  /** v1.7.1 — hard upper bound on number of clips kept when no budget
   *  is enforced. Stops a 30-minute video from spawning 25+ clips and
   *  breaking ffmpeg.wasm's input list. */
  maxClipsWithoutBudget: 12,
  /** v1.7.1 — hard upper bound on total duration (seconds) when no
   *  budget is enforced. Lets quality-floor runs return naturally
   *  short OR naturally long results, but caps the worst case. */
  maxTotalSecondsWithoutBudget: 180
} as const;

// =====================================================================
// v1.9.x (issue #62) — Target-coverage guardrails + CPU/offline best-parts.
//
// THE BUG: "make a best picks for reels for 40 sec" produced a single 1.0s
// low-confidence clip and was marked "ready to render". When the user states
// an explicit duration, the result must reasonably FILL that target; if it
// can't (especially with weak/low confidence or when the visual verdict is
// unavailable) the app must say so and ask — never silently ship a 1s short.
//
// These are SAFETY GUARDRAILS + CONFIDENCE thresholds, not editorial choices.
// There is no fixed clip count and no forced default duration here — clip
// count/length stay emergent from the request, the source, and the candidate
// spread. All fractions below are of the user's requested duration.
// =====================================================================

export const TARGET_COVERAGE = {
  /** At/above this fraction of the requested duration the result is
   *  considered well-filled and may be marked "ready to render". */
  minReadyFraction: 0.6,
  /** Below this fraction the result is a HARD underfill (e.g. a 1s clip for a
   *  40s ask). Never auto-ready — always ask / offer a broader reel. */
  hardUnderfillFraction: 0.25,
  /** When confidence is weak/low AND coverage is below this fraction, ask the
   *  user before proceeding instead of rendering a weak short. */
  weakConfidenceAskFraction: 0.5,
  /** Smallest clip length (seconds) that counts as "useful" output. Single-
   *  frame / 1s peaks are expanded up to at least this before selection so a
   *  reel is made of watchable clips, not flashes. */
  minUsefulClipSeconds: 3
} as const;

/** CPU/offline best-parts fallback (lib/pipeline/bestParts.ts). Used when the
 *  visual verdict is unavailable (cloud disabled / WebGPU absent) or matches
 *  are weak: build a broad, SPREAD reel from local evidence (candidate windows
 *  + motion/saliency scores) instead of returning one random peak. No heavy
 *  dependency, no WebGPU, no cloud. */
export const OFFLINE_BEST_PARTS = {
  /** Preferred per-clip length (seconds) when expanding a short peak so a reel
   *  of N clips ≈ target. Always clamped to the plan's maxClipSeconds. */
  preferredClipSeconds: 8,
  /** Fill clips until the total reaches this fraction of the target. A little
   *  overshoot is fine — the existing over-budget nudge handles trimming. */
  fillToFraction: 1.0,
  /** Hard cap on fallback clip count (protects ffmpeg.wasm input lists).
   *  Mirrors PLAN_DEFAULTS.maxClipsWithoutBudget. */
  maxClips: 12
} as const;

// =====================================================================
// v1.9.x (issue #64) — Professional video-prompt interpreter guardrails.
//
// The prompt interpreter (lib/intent/videoPromptInterpreter.ts) parses
// messy real-user editing prompts into structured slots (duration, clip
// count, format, platform, source scope, topic) BEFORE the specialized
// detectors run. These are PARSE BOUNDS only — they never inject editorial
// behaviour (no fixed clip count, no forced duration, no genre table).
// =====================================================================
export const VIDEO_PROMPT = {
  /** Accepted parsed-duration window (seconds). Mirrors
   *  PLAN_BOUNDS.targetShortSeconds; values outside are clamped, not invented. */
  durationSeconds: { min: 2, max: 600 },
  /** Accepted parsed clip-count window. A user asking for "at least 5 clips"
   *  is clamped here; we never default a count when the user didn't state one. */
  clipCount: { min: 1, max: 40 },
  /** Max sources an all-source compose will fan out across (protects the
   *  per-source vision passes + ffmpeg input list on huge libraries). */
  maxComposeSources: 8
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
  /** libx264 preset. v1.5.1: "ultrafast" cuts encode time ~2x in WASM
   *  for ~10-15% larger output. Acceptable trade-off for shorts. */
  preset: "ultrafast",
  /** libx264 tune. "fastdecode" lowers decoder cost on the destination
   *  device — mobile playback is smoother on the rendered output. */
  tune: "fastdecode",
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
  /** CSP must allow wasm + CDN scripts for ffmpeg + transformers.
   *  connect-src allows huggingface.co for transformers.js (SigLIP /
   *  Whisper / captioning) AND for the OPTIONAL WebLLM local-LLM fallback
   *  model weights; raw.githubusercontent.com is re-allowed for WebLLM's
   *  prebuilt model-library .wasm files (mlc-ai/binary-mlc-llm-libs).
   *  WebLLM is lazy-loaded and opt-in (NEXT_PUBLIC_LOCAL_LLM_*); when the
   *  feature is off nothing is fetched from these origins for it. */
  contentSecurityPolicy:
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://cdn.jsdelivr.net; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob: https:; " +
    "font-src 'self' data:; " +
    "media-src 'self' blob:; " +
    "connect-src 'self' https://*.googleapis.com https://*.groq.com https://huggingface.co https://*.huggingface.co https://raw.githubusercontent.com https://unpkg.com https://cdn.jsdelivr.net; " +
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



/**
 * v1.6.0 — video-library limits. Count cap remains to avoid a huge source list.
 * Byte caps stay high enough to avoid blocking normal local-file selection.
 */
export const LIBRARY_LIMITS = {
  /** Max number of videos a single session can hold at once. */
  maxCount: 8,
  /** Practical local-file cap; far above browser-feasible video sizes. */
  maxTotalBytes: Number.MAX_SAFE_INTEGER,
  /** Practical local-file cap; far above browser-feasible video sizes. */
  maxSingleBytes: Number.MAX_SAFE_INTEGER
} as const;

/**
 * v1.6.0 — palette used to color-code clips by source on the timeline.
 * 8 entries paired with the LIBRARY_LIMITS.maxCount. Hand-tuned for
 * legibility on the dark background and to be visually distinct from
 * the focus / accent tokens in globals.css. If you bump maxCount,
 * extend this array to match.
 */
export const SOURCE_COLORS: readonly string[] = [
  "#7AA2F7", // indigo
  "#9ECE6A", // green
  "#E0AF68", // amber
  "#F7768E", // rose
  "#BB9AF7", // violet
  "#7DCFFF", // cyan
  "#E5C07B", // sand
  "#FF9E64"  // orange
] as const;



// =====================================================================
// v1.7.3 — Local audio (Whisper / ASR) configuration.
//
// Phase 1 ships English-only Whisper variants via @huggingface/transformers
// (already a dep). Capability-tier-driven model selection mirrors the
// existing SigLIP gating pattern in useCapability.ts. All values can be
// changed without touching call sites; the only consumers are
// lib/audio/transcribe.ts and lib/audio/whisper.worker.ts.
// =====================================================================

export const AUDIO = {
  /** Whisper "base.en" — best accuracy still small enough for desktops
   *  with WebGPU. ~74 MB quantized. */
  modelHigh: "Xenova/whisper-base.en",
  /** Whisper "tiny.en" — solid baseline accuracy, 39 MB. The default
   *  for typical browsers. */
  modelMid: "Xenova/whisper-tiny.en",
  /** Same tiny.en — we don't have a smaller English-only model that's
   *  reliably faster on WASM. We keep mid and low identical until a
   *  better lower-tier option lands (Moonshine onnx is the candidate). */
  modelLow: "Xenova/whisper-tiny.en",
  /** Whisper's canonical 30-second window. The model itself was
   *  trained with this length; deviating costs accuracy. */
  chunkLengthSeconds: 30,
  /** 5-second stride between chunks so word boundaries don't get cut. */
  strideLengthSeconds: 5,
  /** Expected real-time-factor on WebGPU. Used only to drive the
   *  smoothed progress bar; set conservatively so the bar never
   *  overshoots. ~3x means a 60-second clip transcribes in ~20s. */
  expectedRtfWebGPU: 3,
  /** Same on WASM. Closer to 1x realtime — the bar will look slow on
   *  long videos in this tier, which is honest. */
  expectedRtfWasm: 1
} as const;



// =====================================================================
// Cloud model provider — OpenRouter (SERVER-SIDE) configuration.
//
// v1.8.x — The in-browser WebLLM / WebGPU local language layer was REMOVED
// (multi-GB model downloads, WebGPU/device instability, poor universal
// support, and — critically — API keys must never run in the browser).
// Language + tool routing now happens SERVER-SIDE via OpenRouter's
// OpenAI-compatible API, with the existing Gemini/Groq providers kept as
// fallbacks (see CLOUD_PROVIDER_ORDER below + lib/providers/cloud.ts).
//
// SECURITY: the OpenRouter API key is SERVER-ONLY (OPENROUTER_API_KEY, read
// via lib/env.ts). It is never sent to the browser and there is no
// NEXT_PUBLIC_OPENROUTER_API_KEY.
//
// VISION HONESTY: OpenRouter handles vision ONLY when the configured model
// is multimodal (the default google/gemini-2.5-flash is). Direct Gemini
// remains the vision fallback. We never fake frame/caption data, and full
// video bytes never leave the browser — only the already-sampled frames are
// sent to the cloud vision routes (same as before; the destination can now
// be OpenRouter instead of Google directly).
//
// Model ids are OpenRouter slugs; each can be overridden via env
// (OPENROUTER_*_MODEL). Only consumers are lib/providers/openrouter.ts and
// the dispatcher lib/providers/cloud.ts.
// =====================================================================

export const OPENROUTER = {
  /** OpenAI-compatible chat-completions endpoint. */
  endpoint: "https://openrouter.ai/api/v1/chat/completions",
  /** Sent as the X-Title header (labels traffic in the OpenRouter dashboard). */
  appTitle: "Shorts Studio",
  /** Default planner + vision model. Multimodal, fast, free-tier friendly.
   *  Override with OPENROUTER_DEFAULT_MODEL. */
  defaultModel: "google/gemini-2.5-flash",
  /** Cheaper/faster model for light turns. Override OPENROUTER_CHEAP_MODEL. */
  cheapModel: "google/gemini-2.5-flash-lite",
  /** Premium model for harder reasoning. Override OPENROUTER_PREMIUM_MODEL. */
  premiumModel: "anthropic/claude-sonnet-4.5",
  /** Open-source fallback. Override OPENROUTER_OSS_MODEL. */
  ossModel: "qwen/qwen3-coder",
  /** Default sampling temperature for planner / JSON turns. */
  temperature: 0.4,
  // ---- max_tokens safety caps ---------------------------------------
  // OpenRouter PRE-RESERVES credits for the requested completion window. An
  // uncapped request defaults to the model's FULL window (e.g. 65535), which
  // 402s low-credit accounts ("requested up to 65535 tokens, but can only
  // afford 16000"). We therefore (a) give every call-type a small default and
  // (b) HARD-CLAMP every request to `hardMaxTokens` so 65535 can NEVER be
  // sent. Our JSON outputs (a plan / a briefing) are small, so these are
  // generous in practice.
  /** Default cap for text planner / chat / edit-command JSON turns. */
  plannerMaxTokens: 1200,
  /** Default cap for vision / briefing JSON turns (a little more headroom). */
  visionMaxTokens: 1600,
  /** ABSOLUTE ceiling for ANY OpenRouter call. Every request's max_tokens is
   *  clamped to this — callers asking for more (e.g. a 3072 briefing retry)
   *  are silently reduced. Overridable ONLY via the OPENROUTER_MAX_TOKENS env
   *  (a deliberate, safe internal config knob); when set it replaces this
   *  ceiling. Keep this well below the model's full window so we never 402 on
   *  a tight credit budget. */
  hardMaxTokens: 2048,
  // ---- transient-error resilience -----------------------------------
  /** Transient-error resilience for OpenRouter calls. The model is sometimes
   *  "temporarily overloaded" (HTTP 429/5xx) or a network blip occurs; these
   *  usually clear within a second or two. The client retries the SAME
   *  request on transient errors with exponential backoff + jitter before
   *  giving up, mirroring the Gemini provider. With CLOUD_PROVIDER_ORDER
   *  pinned to a single provider (no cross-provider fallback), this retry is
   *  what keeps a brief overload from surfacing to the user as an error.
   *  Non-transient errors (e.g. 400/401/402/403) are NOT retried. */
  retryAttempts: 3,
  /** Base backoff in ms; delay grows as base * 2**attempt + jitter. */
  retryBaseDelayMs: 600
} as const;

// Cloud provider PREFERENCE ORDER. The dispatcher (lib/providers/cloud.ts)
// walks this list and skips any provider whose key is absent. OpenRouter is
// preferred when OPENROUTER_API_KEY is set; Gemini direct is the next
// fallback; Groq is text-only (skipped for vision). This array is the single
// place to re-order provider preference.
export const CLOUD_PROVIDER_ORDER = ["openrouter", "gemini", "groq"] as const;



// =====================================================================
// Local frame CAPTIONING (image-to-text) configuration.
//
// OPTIONAL, capability-gated, in-browser. Produces a short natural-
// language caption per sampled frame so the frame-tree and the offline
// reasoning engine get semantic context WITHOUT any cloud call. When the
// device can't run it (no WebGPU / low memory) or the model fails to
// load, the pipeline silently degrades to motion + saliency only — the
// caption field just stays empty. Mirrors the AUDIO tier pattern and the
// SigLIP capability gating in useCapability.ts.
//
// Models are transformers.js-compatible ONNX repos verified to exist:
//   - Florence-2-base: stronger, multi-task, ~230 MB. WebGPU desktops.
//   - vit-gpt2-image-captioning: the proven lightweight default, ~50 MB
//     quantized. Solid single-sentence captions with minimal deps.
// Only consumers are lib/vision/caption.worker.ts + lib/vision/caption.ts.
// =====================================================================

export const CAPTION = {
  /** High tier — Florence-2 base (multi-task VLM). Best caption quality,
   *  needs WebGPU + adequate memory. */
  modelHigh: "onnx-community/Florence-2-base",
  /** Mid tier — ViT-GPT2, the established lightweight captioner. Good
   *  one-sentence descriptions, runs on WASM if needed. */
  modelMid: "Xenova/vit-gpt2-image-captioning",
  /** Low tier — same lightweight captioner; we don't ship a smaller
   *  reliable option yet, so low == mid until one lands. */
  modelLow: "Xenova/vit-gpt2-image-captioning",
  /** Florence-2 task token for plain captioning. Ignored by ViT-GPT2. */
  florenceTask: "<CAPTION>",
  /** Max new tokens per caption. Captions are short by design — this
   *  bounds latency and keeps the frame-tree token-lean. */
  maxNewTokens: 32,
  /** Caption every Nth sampled frame, not every frame. Captioning is the
   *  most expensive optional step; 1 caption per ~4 samples is plenty to
   *  label shots/scenes in the tree while keeping the pass fast. The
   *  uncaptioned frames inherit context from their shot. */
  captionStride: 4,
  /** Hard cap on number of frames captioned in a single pass, to bound
   *  worst-case time on very long videos. */
  maxCaptionedFrames: 64
} as const;



// =====================================================================
// Deterministic plan SYNTHESIS (synthesizeVaguePlan fallback) tunables.
//
// Used by app/api/agent/route.ts when the LLM fails to emit a usable plan
// but the turn is clearly actionable (briefing in scope / anti-loop). The
// fallback grounds ONE scenario in the user's text plus a compact context
// phrase distilled from briefing best-part labels — NOT a separate
// scenario per label (which over-broadened specific requests). Generic;
// no genre/keyword tables. See the Bug 2 fix.
// =====================================================================

export const SYNTH_PLAN = {
  /** Max briefing best-part labels folded into the single grounded
   *  scenario's context phrase. Keeps the prompt focused on the user's
   *  actual request rather than diluting it across every best part. */
  maxContextLabels: 3,
  /** Hard cap on the joined context-phrase length (chars), so the
   *  scenario prompt stays compact. */
  maxContextChars: 120
} as const;
// =====================================================================
// LOCAL-FIRST editor wiring — REMOVED (v1.8.x).
//
// The flag-gated, in-browser WebLLM model-driven router (lib/llm/*,
// NEXT_PUBLIC_LOCAL_FIRST_EDITOR) was removed in favour of SERVER-SIDE
// OpenRouter (see OPENROUTER + CLOUD_PROVIDER_ORDER above). The
// deterministic, non-model client paths it used to share with the cloud
// flow remain intact:
//   - structured briefing follow-ups (lib/briefing/followups.ts,
//     hooks/useBriefingActions.ts)
//   - the grammar quick-shortcut gate (lib/intent/*)
//   - promote / extract / reset, which still run via the cloud planner's
//     modes and their existing client handlers.
// No LOCAL_FIRST confidence tunables are needed any more, so the block was
// removed rather than left dangling.
// =====================================================================

// =====================================================================
// Structured BRIEFING FOLLOW-UP normalization (lib/briefing/followups.ts).
//
// Legacy + current briefing API output is plain strings. We normalize
// each string into a structured BriefingFollowUp so the chip carries
// intent instead of forcing the planner to re-guess from text.
//
// This is intentionally NOT a genre/keyword table. It is a tiny, bounded
// set of generic "use the moments I already found" phrasings. A string
// that matches becomes a deterministic `promote`; everything else becomes
// a `plan_topic` grounded in the briefing. The real intent-carrying
// mechanism is the structured action — this heuristic only exists to
// upgrade legacy strings without breaking old sessions.
// =====================================================================

export const BRIEFING_FOLLOWUP = {
  /** Generic substrings that signal "lift the best parts I already found
   *  onto the timeline" (a deterministic promote). Lowercased; matched as
   *  case-insensitive substrings. Kept short and domain-agnostic — do NOT
   *  grow this into a per-genre keyword table. */
  promoteHints: [
    "reel of these",
    "reel of those",
    "use these",
    "use those",
    "clip these",
    "clip those",
    "clip the best",
    "use the best",
    "these moments",
    "those moments",
    "highlight reel",
    "add them",
    "add these",
    "add those"
  ],
  /** Default signal-fusion profile for a `plan_topic` chip. Semantic-heavy
   *  because the chip names a concrete subject to look for. Mirrors
   *  SIGNAL_DEFAULTS.scenarioHeavy; referenced by name there to avoid
   *  drift. */
  planTopicSignals: SIGNAL_DEFAULTS.scenarioHeavy
} as const;



// =====================================================================
// Agentic intent layer (lib/intent command parsing, lib/agent-memory,
// lib/timeline, lib/agent orchestrator). Tunables + DOCUMENTED guardrails
// for the deterministic agent that resolves natural editing commands.
//
// IMPORTANT: the numbers below are SAFETY GUARDRAILS for browser memory /
// render stability and CONFIDENCE thresholds — NOT hidden editing
// decisions. There is deliberately no fixed output clip-count or forced
// duration here; clip count/length stay emergent from the user's request
// and the existing pipeline's quality-floor selection.
// =====================================================================

/** Confidence thresholds for the agent's execute / assume / clarify
 *  decision (lib/agent-memory/policy.ts). */
export const AGENT_POLICY = {
  /** >= this → execute the command directly, no question. */
  executeThreshold: 0.85,
  /** >= this (but < executeThreshold) → execute but surface the
   *  assumption in chat ("Using video 2 because…"). */
  noteThreshold: 0.65,
  /** Below noteThreshold → ask a short clarification instead of acting. */
  // (anything < noteThreshold)
} as const;

/** Guardrails for agent-resolved timeline operations. These bound
 *  browser/render stability; they are NOT editorial choices. */
export const AGENT_GUARDRAILS = {
  /** Largest single agent-added range, in seconds. A user asking for a
   *  bigger explicit range is honoured up to the source duration — this
   *  only bounds runaway concept matches. */
  maxAgentClipSeconds: 600,
  /** Smallest meaningful clip the agent will create. */
  minAgentClipSeconds: 0.3,
  /** Default seconds added by an "extend clip" when the user doesn't
   *  name an amount. */
  defaultExtendSeconds: 2,
  /** Cap on how many concept matches a single "add the X" turn returns
   *  before the existing timeline merge cap applies. Generic "best
   *  parts" is NOT capped here — it flows through the pipeline's
   *  quality-floor path (no fixed count). */
  maxConceptMatchesPerTurn: 8
} as const;



// =====================================================================
// Offline storage / cache budget (lib/storage/*).
//
// The app caches models (transformers.js / Whisper), sampled frame
// predictions, transcripts, rendered files, and project/session data
// locally. Without a budget the browser can silently grow to multiple
// GB. These caps drive the storage manager's over-budget warnings +
// cleanup prompts. Power Mode may exceed them only after explicit user
// confirmation. NOT hidden behaviour — surfaced in the storage panel.
// =====================================================================

const MB = 1024 * 1024;

export const STORAGE_BUDGET = {
  /** Caps for phones / low-memory devices. */
  mobile: {
    modelBytes: 150 * MB,
    frameBytes: 50 * MB,
    renderBytes: 100 * MB
  },
  /** Caps for desktops / capable devices. */
  desktop: {
    modelBytes: 600 * MB,
    frameBytes: 300 * MB,
    renderBytes: 500 * MB
  },
  /** Show a storage warning + ask permission before downloading any
   *  model larger than this. Keeps a large vision/LLM model from
   *  silently consuming the cache. */
  modelDownloadWarnBytes: 80 * MB
} as const;



// =====================================================================
// Per-boundary transitions (lib/transitions/*) — PR 58 foundation.
//
// Centralized, documented duration guardrails (allowed by CONSTRAINTS:
// "transition duration defaults if centralized and documented"). The
// render worker currently implements only none/fade/crossfade; richer
// types are captured for intent and mapped DOWN honestly (see
// lib/transitions/map.ts). Render + UI wiring is a follow-up.
// =====================================================================

export const TRANSITIONS = {
  /** Default transition duration (seconds) when a boundary doesn't name one. */
  defaultDurationSeconds: 0.4,
  /** Hard cap so a transition can't eat a short clip. */
  maxDurationSeconds: 1.0,
  /**
   * Thresholds for the deterministic AUTO transition picker
   * (lib/transitions/auto.ts). These are TECHNICAL guardrails on generic
   * media signals — NOT editorial/genre rules. There are deliberately no
   * per-genre transition choices anywhere; the picker only reads
   * source-continuity, time gaps, motion/saliency contrast, transcript/tag
   * overlap, and explicit user preference.
   */
  autoPick: {
    /** Max gap (s) between prev.end and next.start on the SAME source for
     *  the boundary to count as "temporally adjacent" (→ hard cut). */
    sameSourceAdjacentGapSeconds: 1.0,
    /** Transcript/tag overlap at/above this is "related topic" (→ crossfade
     *  across sources rather than a fade). 0..1. */
    relatedTopicFloor: 0.35,
    /** Motion at/above this on either side is "high motion" (→ cut to keep
     *  energy). 0..1. */
    highMotionFloor: 0.6,
    /** Motion at/below this on both sides is "low/calm" (→ smoother
     *  crossfade). 0..1. */
    lowMotionCeiling: 0.25,
    /** Motion/saliency contrast at/above this is a "strong contrast"
     *  (→ fade to absorb the jump). 0..1. */
    strongContrastFloor: 0.45,
    /** Confidence assigned to a clear auto pick when no stronger/weaker
     *  signal adjusts it. 0..1. */
    defaultConfidence: 0.65
  }
} as const;



// =====================================================================
// v2.2 — Dynamic progressive local-analysis budget (lib/analysis/*).
//
// Replaces the single fixed ~240-frame cap with a DYNAMIC budget chosen per
// request. A human editor doesn't scan every frame for every question:
//   - exact edit / read-only / merge → 0 frames
//   - "describe this" → a few keyframes
//   - "best parts" of a short clip → a light scan
//   - "best parts" of a long video → a coarse scan, then deep ONLY on the
//     best candidate windows
//   - "find the red car" → coarse scan first, semantic deep scan on candidates
//
// These are SAMPLING GUARDRAILS only — they never inject editorial behaviour
// (no fixed clip count, no forced duration, no genre table). All frame counts
// are upper bounds; short videos sample fewer frames naturally. The device
// tier (DEVICE_TIER) shifts the usable ceiling WITHIN each band. Consumers:
// lib/analysis/budget.ts (+ executePerSource via an optional budget).
// =====================================================================

export const ANALYSIS = {
  /** Quick "describe / what's in this" — a few evenly spread keyframes. */
  quickDescribe: { minFrames: 5, maxFrames: 12, inferenceWidth: 224, baseEverySeconds: 2.5 },
  /** Short-video best-parts — a light scan. */
  quickScan: { minFrames: 24, maxFrames: 80, inferenceWidth: 224, baseEverySeconds: 1.0 },
  /** Normal best-parts — the default scan for medium videos. */
  normalScan: { minFrames: 80, maxFrames: 180, inferenceWidth: 320, baseEverySeconds: 1.0 },
  /** Long-video coarse scan — bounded, evenly spread. */
  longVideoScan: { minFrames: 180, maxFrames: 360, inferenceWidth: 320, baseEverySeconds: 5.0 },
  /** Deep visual search — large but ONLY after coarse candidate filtering. */
  deepScan: { minFrames: 240, maxFrames: 600, inferenceWidth: 384, baseEverySeconds: 0.5 },
  /** Dense pass run ONLY around the top candidate windows. */
  denseWindow: { maxCandidateWindows: 16, framesPerWindow: 8 },
  /** Duration thresholds (seconds) that switch a best-parts scan between the
   *  short / normal / long bands. */
  thresholds: {
    /** At/below this a "best parts" run uses the quick band. */
    shortVideoSeconds: 30,
    /** At/above this a "best parts" run uses the long-video coarse band. */
    longVideoSeconds: 600
  }
} as const;

// =====================================================================
// v2.2 — Device tier (lib/analysis/deviceTier.ts).
//
// A coarse local capability estimate (NOT a fingerprint, never sent to the
// server) used ONLY to shift the analysis frame ceiling. Signals: hardware
// concurrency, navigator.deviceMemory (when available), WebGPU availability.
// =====================================================================

export const DEVICE_TIER = {
  /** Multiplier applied to a band's max frame count per tier. The result is
   *  clamped back into the band's [min,max], so a tier only shifts the
   *  usable ceiling — it never invents frames beyond the configured max. */
  frameFactor: {
    low: 0.5,
    mid: 0.8,
    high: 1.15,
    unknown: 1.0
  },
  /** "high" needs WebGPU AND at least one of these. */
  highTierMinDeviceMemoryGB: 8,
  highTierMinHardwareConcurrency: 8,
  /** "mid" needs at least one of these (else "low"). */
  midTierMinDeviceMemoryGB: 4,
  midTierMinHardwareConcurrency: 4
} as const;

// =====================================================================
// v2.2 — Clarification policy (lib/analysis/clarificationPolicy.ts).
//
// When the first cheap analysis is low-confidence or the request is vague,
// ASK the user one focused question instead of blindly running expensive
// deeper analysis. Thresholds are guardrails, not editorial rules.
// =====================================================================

export const CLARIFY_POLICY = {
  /** Below this quick-scan confidence (0..1) we ask before deeper analysis. */
  lowConfidence: 0.35,
  /** Distinct strong content types in the quick scan at/above this → ask
   *  which to prioritize (talking vs action vs static, etc.). */
  multiContentTypeFloor: 2,
  /** Candidate-window strength (0..1) below this counts as "weak windows". */
  weakWindowCeiling: 0.3,
  /** If the best achievable coverage of an explicit target is below this
   *  fraction, ask whether to broaden the search. Mirrors TARGET_COVERAGE. */
  underfillAskFraction: 0.5
} as const;

// =====================================================================
// v2.2 — Overlap resolver (lib/timeline/overlapResolver.ts).
//
// When an incoming clip overlaps an existing same-source clip, never silently
// drop/replace a meaningful clip when intent is unclear — ask the user.
// =====================================================================

export const OVERLAP = {
  /** Overlap ratio (overlap / incoming-duration) at/above which the clips are
   *  treated as conflicting and the user is asked. Below this they coexist. */
  conflictRatio: 0.5,
  /** Minimum overlap (seconds) for a conflict at all — sub-frame touches are
   *  ignored so adjacent clips that share a boundary don't trip it. */
  minOverlapSeconds: 0.3
} as const;



// =====================================================================
// v2.2 — Global multi-video planner (lib/analysis/globalVideoPlanner.ts).
//
// When several videos are selected, build a GLOBAL plan (roles + order +
// strategy) before per-source clip picking, so one source doesn't dominate
// unless the user asked for best-only. Guardrails, not editorial rules.
// =====================================================================

export const GLOBAL_PLAN = {
  /** In "balanced" mode, the max fraction of the output any single source
   *  may take (prevents one video dominating a multi-video edit). */
  balancedMaxShare: 0.6,
  /** Motion score (0..1) at/above which a source is considered the likely
   *  "main action" candidate when good-window counts tie. */
  mainActionMotionFloor: 0.5
} as const;


// =====================================================================
// v2.2 — Quick local scan (lib/analysis/quickScanResult.ts + the editor's
// "Run a quick local scan" command path).
//
// A bounded, LOCAL, model-free pass: sample a few keyframes, read their
// (already-computed) motion + saliency, and derive a compact structural
// memory (motion/saliency peaks, static ranges, candidate windows). These
// are SAMPLING/STRUCTURE guardrails only — no genre table, no fixed clip
// count, no fabricated captions. The scan only reports STRUCTURE, never
// claims to name on-screen subjects.
// =====================================================================

export const QUICK_SCAN = {
  /** A frame's motion (0..1) at/above this is a "motion peak". */
  motionPeakFloor: 0.45,
  /** A frame's saliency (0..1) at/above this is a "busy/varied" frame. */
  saliencyPeakFloor: 0.6,
  /** A frame with motion at/below this AND saliency at/below the floor is
   *  treated as a static / low-interest moment. */
  staticMotionCeiling: 0.12,
  /** Combined interest = motionWeight*motion + saliencyWeight*saliency. */
  motionWeight: 0.6,
  saliencyWeight: 0.4,
  /** Combined-interest score (0..1) at/above which a keyframe seeds a
   *  "known good" candidate window. */
  goodWindowFloor: 0.5,
  /** Caps so the stored memory stays compact (NO raw frames either way). */
  maxKeyframes: 16,
  maxWindows: 12,
  /** A scan is "low confidence" (→ may ask to scan deeper) when the best
   *  combined-interest score is below this. Mirrors CLARIFY_POLICY. */
  lowConfidenceCeiling: 0.35
} as const;


// =====================================================================
// v2.3 — Editor-first turn routing (lib/intent/editorTurnIntent.ts +
// editingNormalize / refinementIntent / topicPhrases).
//
// These are GENERIC editing-vocabulary guardrails — NOT a genre, entity, or
// game table. The lexicon is a small, extensible set of cross-domain
// editing-control and content-STRUCTURE words (every video has "intro",
// "talking", "action", etc.). It exists ONLY to (a) correct obvious typos
// to a known editing word and (b) recognise control/refinement phrasing.
// Real CONTENT subjects the user types are never in here and are preserved
// verbatim as topic phrases.
// =====================================================================

export const EDITOR_TURN = {
  /** Generic editing / content-structure vocabulary used for fuzzy typo
   *  correction. Extensible. NEVER add proper nouns, brand/character/boss
   *  names, game titles, or genre subjects here — those stay user topics. */
  editingLexicon: [
    // control / timeline verbs
    "trim", "remove", "delete", "keep", "drop", "cut", "split", "merge",
    "combine", "render", "export", "undo", "redo", "replace", "filter",
    // generic content-STRUCTURE categories common across many videos
    "intro", "outro", "cutscene", "dialogue", "transition", "montage",
    "combat", "fight", "fighting", "action", "talking", "boring", "scene",
    "highlight", "moment", "clip", "segment", "continuous",
    // quality / scope words
    "best", "current", "selected", "timeline", "video", "vertical",
    "horizontal", "square"
  ] as string[],
  /** Max edit distance (Damerau-Levenshtein) for a typo correction. Tokens
   *  shorter than `minTokenLenForFuzzy` are never fuzzy-corrected (too noisy).
   *  Distance 2 is only allowed for longer tokens. */
  fuzzy: {
    minTokenLenForFuzzy: 4,
    maxDistanceShort: 1,
    longTokenLen: 8,
    maxDistanceLong: 2
  },
  /** Confidence floors for the editor-turn classifier. */
  confidence: {
    /** At/above this a deterministic editor-turn classification is trusted. */
    strong: 0.8,
    /** At/above this we act/ask; below we fall through to the planner. */
    act: 0.6
  }
} as const;



// =====================================================================
// v2.5 — Chat Brain Preload (lib/llm/chatBrainPreload.ts +
// hooks/useChatBrainPreload.ts + app/api/agent/intent/route.ts).
//
// A lightweight, privacy-safe TEXT-ONLY intent/clarify-answer brain that is
// warmed in the background after the editor is ready (or after upload
// begins), so the first real chat turn is fast. It is used ONLY as a
// fallback when the deterministic resolver's confidence is low. It NEVER
// receives video bytes, frames, thumbnails, or raw transcript — only compact
// text state (see lib/llm/chatBrainSchema.buildChatBrainPayload).
//
// Deterministic commands (undo/redo/render/export/trim/yes-no) NEVER touch
// the brain. When no provider is available the app stays in deterministic
// mode with no error surfaced.
// =====================================================================
export const CHAT_BRAIN = {
  /** Master switch for the preload + LLM fallback layer. */
  preloadEnabled: true,
  /** Delay (ms) after the trigger before warmup fires (lets the editor settle). */
  preloadDelayMs: 800,
  /** Warm up once the editor mounts. */
  preloadOnEditorMount: true,
  /** Also (re)try warmup when the first upload begins. */
  preloadOnUploadStart: true,
  /** Allow the cheap server/cloud text warmup request. */
  cloudWarmupEnabled: true,
  /** Allow a local in-browser text model warmup (off by default — heavy). */
  localWarmupEnabled: false,
  /** Give up a warmup attempt after this long. */
  maxWarmupMs: 8000,
  /** Resolve calls time out after this long (then deterministic null). */
  resolveTimeoutMs: 7000,
  /** Skip LOCAL model preload below this device memory (GB). Cloud warmup
   *  is cheap and still allowed. navigator.deviceMemory is coarse + optional. */
  minDeviceMemoryGb: 4,
  /** Skip warmup entirely when the user enabled Data Saver. */
  skipWhenSaveData: true,
  /** Only call the LLM fallback when the deterministic resolver confidence is
   *  below this (kept high so exact/clear answers stay deterministic + free). */
  useOnlyForLowConfidence: true,
  confidenceThreshold: 0.72,
  /** A brain answer must reach at least this confidence to be applied. */
  minApplyConfidence: 0.6
} as const;

// =====================================================================
// v2.5 — Dynamic clip durations (lib/pipeline/clipDuration.ts).
//
// Replaces the effectively-fixed ~3s clip length with DYNAMIC bounds derived
// from the source video length (and the user's target when stated). Clips can
// be as short as ~1s and as long as a sensible fraction of the video, and the
// per-clip length VARIES with interest score (stronger peak → longer clip) so
// a reel isn't a row of identical 3s blocks. These are GUARDRAILS only — no
// fixed clip count, no forced duration; the user's explicit min/max always
// wins when provided.
// =====================================================================
export const CLIP_DURATION = {
  /** Absolute floor — a clip is never shorter than this (seconds). */
  absoluteMinSeconds: 1,
  /** Absolute ceiling — a clip is never longer than this (seconds). */
  absoluteMaxSeconds: 30,
  /** min clip = clamp(videoDuration * minFractionOfVideo, absoluteMin, minCeiling). */
  minFractionOfVideo: 0.01,
  minCeilingSeconds: 3,
  /** max clip = clamp(videoDuration * maxFractionOfVideo, maxFloor, absoluteMax). */
  maxFractionOfVideo: 0.06,
  maxFloorSeconds: 4,
  /** Preferred (typical) clip sits this fraction between min and max. */
  preferredBetween: 0.45,
  /** When a target duration is stated, preferred clip ≈ target / this many
   *  clips (so a short target yields a few watchable clips, not many slivers). */
  preferredClipsForTarget: 6
} as const;


// =====================================================================
// CONSTRAINT-FIRST editing pipeline (lib/constraints/*).
//
// The HARD GATE that enforces include-only / exclude semantic constraints
// BEFORE scoring + selection.
//
// IMPORTANT — these are NOT fixed score thresholds. CLIP/SigLIP zero-shot
// similarity is miscalibrated (the same true match can score 0.30 on one
// video and 0.55 on another), so a fixed cutoff either drops real matches or
// admits noise. Instead the gate is DISTRIBUTION-ADAPTIVE: it keeps the
// frames whose constraint match stands out from THIS video's own background,
// and relaxes toward a low noise floor when it must cover a stated duration.
// =====================================================================
export const CONSTRAINTS = {
  /** Absolute noise floor. Below this an include concept is treated as
   *  genuinely ABSENT from the frame (not just weakly present), regardless of
   *  the per-video distribution. The ONLY hard floor — kept low because
   *  zero-shot scores for true matches routinely sit in the 0.2-0.4 band.
   *  This is a presence/absence gate, not a quality threshold. */
  includeNoiseFloor: 0.15,
  /** Primary adaptive cutoff: keep frames whose include match is at least
   *  this fraction of the STRONGEST include match seen in the source. Adapts
   *  the gate to each video's own score range instead of a fixed number. */
  includeRelativeFraction: 0.55,
  /** When a hard include yields fewer than this fraction of the target
   *  duration, the gate progressively relaxes the cutoff toward the noise
   *  floor to admit the next-best-matching footage — so a constrained reel
   *  still APPROACHES the requested length using on-constraint frames only,
   *  rather than collapsing to a single clip. Never relaxes below the floor. */
  coverageTargetFraction: 0.8,
  /** Step size used while relaxing the cutoff toward the noise floor. */
  coverageRelaxStep: 0.05,
  /** A frame is dropped as EXCLUDED when its exclude-constraint match is at
   *  or above this fraction of the strongest exclude match in the source. */
  excludeRelativeFraction: 0.6,
  /** Hard floor for the exclude gate so a video with no real excluded content
   *  doesn't drop frames on noise alone. */
  excludeNoiseFloor: 0.2,
  /** When an exclude match exceeds the include match by this margin the frame
   *  is dropped even if it cleared the include cutoff (excluded concept
   *  dominates the frame). */
  excludeDominanceMargin: 0.05,
  /** A candidate window survives the secondary guard only when its mean
   *  include match is at least this fraction of the strongest window mean. */
  windowRelativeFraction: 0.5
} as const;


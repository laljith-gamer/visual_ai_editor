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
   *  Whisper / captioning) model weights. (The raw.githubusercontent.com
   *  entry for WebLLM model-lib .wasm was removed when the browser WebLLM
   *  path was retired in favour of server-side OpenRouter.) */
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
  /** Default max completion tokens for OpenRouter calls that don't pass an
   *  explicit cap (e.g. the planner JSON turn). OpenRouter PRE-RESERVES
   *  credits for the model's FULL completion window when max_tokens is
   *  omitted — for a 65k-output model that means it prices the worst case at
   *  65535 tokens and rejects low-credit accounts with HTTP 402 ("requires
   *  more credits, or fewer max_tokens") before the request even runs. The
   *  planner emits a small structured plan, so a few thousand tokens is
   *  plenty and keeps the reserved budget affordable. Override with
   *  OPENROUTER_MAX_TOKENS; callers that need more (e.g. vision briefing)
   *  pass their own maxTokens, which always wins. */
  maxTokens: 4096
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

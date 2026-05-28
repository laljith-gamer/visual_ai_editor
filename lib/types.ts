// =====================================================================
// Shared types — single source of truth for the whole app.
// =====================================================================

// ---------------------------------------------------------------------
// Plan & pipeline
// ---------------------------------------------------------------------

/** A user-described scenario the AI should look for in frames. */
export interface Scenario {
  id: string;
  prompt: string;
  /** Positive = keep, negative = avoid. Defaults to 1. */
  weight?: number;
}

/** Edit plan emitted by the chat planner. Drives the entire pipeline. */
export interface EditPlan {
  /** Vision targets the per-frame scorer matches against. */
  scenarios: Scenario[];
  /** Map: scenario id → desired weight contribution (0–1, summing to ~1). */
  labelWeights: Record<string, number>;
  /** Final short duration target in seconds.
   *  v1.7.1 — only ENFORCED by the pipeline when `userSpecifiedDuration`
   *  is true. Otherwise this is a soft hint kept for future activation
   *  ("the user might say 30s later"); selection runs on the
   *  quality-floor path instead. */
  targetShortSeconds: number;
  /** v1.7.1 — true ONLY when the user explicitly named a duration this
   *  session ("30s", "minute and a half", "0:45") or used a platform
   *  whose duration is universally fixed (TikTok, YouTube Shorts).
   *
   *  When false:
   *    - The pipeline IGNORES targetShortSeconds and runs the
   *      quality-floor selection path (PLAN_DEFAULTS.qualityFloor).
   *    - mergeAcrossSources skips the budget-fitting step.
   *    - The planner is instructed never to ask "how long?" — total
   *      length is emergent from clip quality.
   *
   *  When true:
   *    - Existing fit-to-budget behaviour applies.
   *    - Append refinements that push past the budget surface a soft
   *      over-budget notice rather than auto-trimming.
   *    - Memory facts persist this preference across turns. */
  userSpecifiedDuration: boolean;
  /** v1.7.1 — minimum composite score for a clip to be retained when
   *  the pipeline is in quality-floor mode (userSpecifiedDuration =
   *  false). Optional; falls back to PLAN_DEFAULTS.qualityFloor. */
  qualityFloor?: number;
  /** Single clip max length in seconds. */
  maxClipSeconds: number;
  /** Single clip min length. */
  minClipSeconds: number;
  /** "balanced" picks across the timeline; "best" picks top scores. */
  selectionStrategy: "balanced" | "best";
  /** Output framing. */
  format: "horizontal" | "vertical" | "square";
  /** Transition between clips. */
  transition: "none" | "fade" | "crossfade";
  /** Free-text styles to keep across re-edits ("cinematic", "captioned"…). */
  styles: string[];
  /** What to skip. */
  avoid: string[];
  /** Sampling parameters. */
  sampleEverySeconds: number;
  inferenceWidth: number;
  /** v1.5.0 — multi-signal fusion weights. Optional in older sessions;
   *  defaults applied in normalizePlan when missing. */
  signals?: SignalWeights;
  /** v1.5.0 — when present, the pipeline filters frames to this range
   *  BEFORE scoring + selection. Used for "first 2 min and pick best". */
  extractRange?: ExtractRange;
  /** Optional human-readable explanation from the planner. */
  rationale?: string;
  /** v1.6.0 — which library sources the planner wants to pull clips
   *  from. Omitted/empty means "all selected sources are eligible".
   *  Each entry is a VideoSource.id. The pipeline filters
   *  `selectedSourceIds` through this list when both are present so
   *  the user's library checkboxes always remain authoritative. */
  sources?: string[];
}

/** A scored frame from the per-frame pass.
 *  v1.5.0: `score` is now the COMPOSITE score (semantic + motion + saliency
 *  fused via plan.signals weights). The individual signals are kept on
 *  the frame so the UI / activity log can show why a frame ranked. */
export interface FrameScore {
  /** Frame timestamp in seconds. */
  t: number;
  /** Composite score driving selection. 0..1. */
  score: number;
  /** SigLIP-derived semantic match against scenarios. 0..1. */
  semantic?: number;
  /** Frame-to-frame pixel-difference (motion / scene change). 0..1. */
  motion?: number;
  /** Histogram-entropy visual saliency. 0..1. */
  saliency?: number;
  /** Per-label raw scores (debug + UI). */
  labels: Record<string, number>;
}

/** v1.5.0 — multi-signal weights the LLM emits per turn. The pipeline
 *  fuses semantic + motion + saliency using these. When `semantic` is 0
 *  the pipeline skips the (expensive) SigLIP pass entirely. */
export interface SignalWeights {
  /** SigLIP semantic match. 0 → skip SigLIP. */
  semantic: number;
  /** Frame-to-frame motion / scene change. */
  motion: number;
  /** Histogram-entropy visual saliency. */
  saliency: number;
}

/** v1.5.0 — time-bound extract. Either a verbatim slice (mode="extract")
 *  or a filter applied before scoring (`EditPlan.extractRange`). */
export interface ExtractRange {
  /** "first": start at 0; "last": resolve from videoDuration; "absolute": as given. */
  kind: "first" | "last" | "absolute";
  startSeconds: number;
  endSeconds: number;
  /** Verbatim user phrasing — kept for the activity log. */
  spoken?: string;
}

/** A candidate window detected from contiguous high-score frames. */
export interface CandidateWindow {
  start: number;
  end: number;
  /** Mean per-frame score inside the window. */
  meanScore: number;
  /** Frames inside, ordered by t. */
  frames: FrameScore[];
}

/** Result of the temporal contact-sheet pass for one window. */
export interface TemporalVerdict {
  start: number;
  end: number;
  keepScore: number; // 0..1
  reason: string;
  label?: string;
}

/** Final highlight clip ready to render. */
export interface Highlight {
  id: string;
  start: number;
  end: number;
  score: number;
  reason: string;
  label?: string;
  transition?: EditPlan["transition"];
  /** v1.3.0 — derived from composite score by `assessConfidence` in
   *  lib/pipeline/adapt.ts. Lets the chat surface "low confidence"
   *  picks without lying about what was chosen. */
  confidence?: "high" | "medium" | "low";
  /** v1.6.0 — which uploaded source this clip is taken from. Optional
   *  for back-compat with single-video sessions; when omitted the
   *  pipeline assumes the currently-active source. The render worker
   *  uses this to pick the right input file in its filter graph. */
  sourceId?: string;
}

// ---------------------------------------------------------------------
// Video library (v1.6.0)
// ---------------------------------------------------------------------

/**
 * One uploaded video held in memory. The library is a list of these.
 * Blob + url are runtime-only (NOT persisted). After a session restore
 * users re-pick the file from disk; `meta` and `hash` are enough to
 * resolve identity and warm cached predictions.
 */
export interface VideoSource {
  /** Stable internal id ("src_…"). Used as a foreign key on Highlight.sourceId. */
  id: string;
  /** sha-256 of the file bytes. Cache key for the predictions store. */
  hash: string;
  /** Held in memory only — re-uploaded on session restore. */
  blob: Blob;
  /** Object URL backing both preview panes. Revoked when the source is
   *  removed or the session is reset. */
  url: string;
  meta: VideoSourceMeta;
  addedAt: number;
}

export interface VideoSourceMeta {
  name: string;
  size: number;
  duration: number;
  width: number;
  height: number;
  /** Display aspect "16:9" / "9:16" / "1:1" — derived; cheaper than recomputing. */
  aspect?: string;
}

/** Compact summary the planner sees in the user-prompt block. We send
 *  metadata only — never the blob — so the prompt stays small. */
export interface VideoLibraryEntry {
  id: string;
  name: string;
  duration: number;
  width: number;
  height: number;
  aspect?: string;
  /** Is this source eligible for the next AI pick? Mirrors the
   *  `selectedSourceIds` checkbox state. The planner MUST honour this. */
  selected: boolean;
  /** Per-source notes accumulated from acknowledge-mode chips
   *  ("source 2 has bad audio", "source 1 is 4K"). Free-text. */
  notes?: string[];
}

/** Persisted-only snapshot of the library — no blobs, no URLs. The user
 *  re-uploads sources on restore; we keep the names + hashes so we can
 *  show "your previous library had 3 sources" hints later. */
export interface VideoSourceSummary {
  id: string;
  hash: string;
  meta: VideoSourceMeta;
  addedAt: number;
}



/** Memory chips persisted across edits in a session. */
export interface SessionMemory {
  duration?: number;
  format?: EditPlan["format"];
  styles: string[];
  keep: string[];
  skip: string[];
}

/** Current pipeline phase (UI status pill). */
export type JobStatus =
  | "idle"
  | "planning"
  | "sampling"
  | "scoring"
  | "temporal"
  | "selecting"
  | "ready"
  | "rendering"
  | "completed"
  | "failed";

/** A full session row in IndexedDB. */
export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  videoMeta?: {
    name: string;
    size: number;
    duration: number;
    width: number;
    height: number;
  };
  /** Hash of the source file bytes (cache key). */
  videoHash?: string;
  /** v1.6.0 — full library snapshot (metadata only, no blobs). When
   *  present, takes precedence over the legacy single `videoMeta` /
   *  `videoHash` pair, which we keep for restoring older sessions. */
  sources?: VideoSourceSummary[];
  /** v1.6.0 — IDs of sources the user had selected for AI use at save time. */
  selectedSourceIds?: string[];
  /** v1.6.0 — which source was active in the preview pane. */
  activeSourceId?: string;
  plan?: EditPlan;
  memory: SessionMemory;
  highlights: Highlight[];
  messages: ChatMessage[];
  status: JobStatus;
  progress: number;
  /** Most recent intent the planner classified for this session. */
  mode?: IntentMode;
}

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: number;
  /** Attached structured data (a plan, an error, clarify question, etc.). */
  attachment?: Record<string, unknown>;
}

// ---------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------

export type CapabilityTier = "high" | "mid" | "low";

export interface Capability {
  tier: CapabilityTier;
  hasWebGPU: boolean;
  hasSharedArrayBuffer: boolean;
  deviceMemoryGB: number;
  hardwareConcurrency: number;
  isMobile: boolean;
}

// ---------------------------------------------------------------------
// Predictions cache
// ---------------------------------------------------------------------

export interface PredictionsCacheEntry {
  videoHash: string;
  scenarioSignature: string;
  sampleEverySeconds: number;
  frames: FrameScore[];
  createdAt: number;
}

// ---------------------------------------------------------------------
// Conversational planner (NEW in v1.1.0)
// ---------------------------------------------------------------------

/** Intent modes the planner can return.
 *  v1.5.0 added "extract" for time-bound verbatim slices ("first 2 min",
 *  "last 90 seconds", "from 0:30 to 1:45").
 *  v1.5.2 added "acknowledge" for context-update turns where the user
 *  is informing the AI about the footage rather than asking for a new
 *  plan ("there's a defeated title", "this is 4K", "the audio is bad").
 *  In acknowledge mode the existing plan and clip state stay untouched
 *  and the assistant just confirms it heard.
 *  v1.6.1 added "edit" for direct timeline manipulations on existing
 *  clips ("trim first 30s", "drop 0:30 to 0:45", "split this clip",
 *  "reset video 2"). Distinct from "extract" which creates a NEW clip
 *  from raw video — "edit" only mutates clips already on the timeline.
 *  v1.6.4 added "describe" for chat Q&A about a specific clip ("what
 *  happens here?", "where does she enter the frame?", "describe this
 *  scene"). The client extracts ~6 frames from the clip and calls
 *  /api/vision/clip; the answer is rendered back into chat. Pipeline
 *  does NOT run; existing plan + clips stay untouched. */
export type IntentMode =
  | "plan"
  | "moment"
  | "extract"
  | "edit"
  | "describe"
  | "briefing"
  | "promote"
  | "acknowledge"
  | "clarify";

/** A field the planner inferred from context (rather than the user
 *  stating it explicitly). Surfaced in the UI so the user can override. */
export interface InferredField {
  /** "format" | "targetShortSeconds" | "scenarios" | etc. */
  field: string;
  /** The inferred value. Stringified for display when not primitive. */
  value: string | number | boolean | string[];
  /** Why we inferred it ("source video is portrait", "you said 'TikTok'"). */
  reason: string;
}

/** A clarify-mode question with quick-reply suggestions. */
export interface ClarifyQuestion {
  /** Stable id for the question — "duration", "format", "topic", etc. */
  id: string;
  prompt: string;
  /** Quick-reply chips. Always include at least one suggestion. */
  suggestions: string[];
  kind: "single-choice" | "free-text";
}

/** Partial plan returned by the LLM on refinement turns. */
export type PlanPatch = Partial<EditPlan> & {
  /** When provided, indicates how to merge `scenarios`:
   *    "replace" → swap the whole array (default)
   *    "append"  → add new ones, dedupe by id
   *    "remove"  → drop matching ids */
  scenariosOp?: "replace" | "append" | "remove";
};

/**
 * v1.6.1 — Direct timeline operations the planner can emit when the
 * user asks for manual edits in chat ("trim first 30s", "drop 0:30 to
 * 0:45", "split this clip", "reset video 2"). Each operation maps 1:1
 * to a store action on the client.
 *
 * `sourceId` is optional. When omitted the client applies the op to
 * whichever source is currently active. When provided, the client
 * temporarily switches the active source, applies the op, and restores
 * the previous active afterwards. The LLM is told to fill in sourceId
 * only when the user named a specific video ("trim video 2" / "use the
 * podcast clip"); generic phrasings ("trim first 30s") leave it blank.
 *
 * Note: this is intentionally a small, closed taxonomy. Anything more
 * exotic ("merge clips", "reorder by sentiment") routes through `plan`
 * mode instead so the AI can think about it as an editorial decision
 * rather than a mechanical mutation.
 */
export type EditOperation =
  | {
      kind: "trim_first";
      /** Drop or shorten clips falling inside [0, seconds) on the source. */
      seconds: number;
      sourceId?: string;
    }
  | {
      kind: "trim_last";
      /** Drop or shorten clips inside [duration−seconds, duration). */
      seconds: number;
      sourceId?: string;
    }
  | {
      kind: "keep_range";
      /** Replace source's clips with one clip [startSeconds, endSeconds]. */
      startSeconds: number;
      endSeconds: number;
      sourceId?: string;
    }
  | {
      kind: "drop_range";
      /** Drop or split clips overlapping [startSeconds, endSeconds]. */
      startSeconds: number;
      endSeconds: number;
      sourceId?: string;
    }
  | {
      /** Split the currently-selected clip in two equal halves. */
      kind: "split_selected";
      sourceId?: string;
    }
  | {
      /** Split whichever clip contains `timeSeconds` at exactly that point. */
      kind: "split_at";
      timeSeconds: number;
      sourceId?: string;
    }
  | {
      /** Clear every clip from one source. Other sources are untouched. */
      kind: "reset_source";
      sourceId?: string;
    };

/** What POST /api/agent expects in the request body. */
export interface AgentRequest {
  /** Full conversation history. The latest user turn is the last item. */
  messages: ChatMessage[];
  /** The currently-active plan, if any. Enables refinement turns. */
  currentPlan?: EditPlan | null;
  /** Source video metadata for inference. Single-video back-compat —
   *  v1.6.0 prefers `videoLibrary` below when present. */
  videoMeta?: {
    duration: number;
    width: number;
    height: number;
  };
  /** v1.6.0 — full library the planner can see. The LLM picks which
   *  sources to pull clips from via `EditPlan.sources`, honouring the
   *  `selected` flag on each entry. */
  videoLibrary?: VideoLibraryEntry[];
  /** v1.6.1 — id of the source currently active in the preview pane.
   *  Tells the LLM which one "this video" / "this clip" refers to. */
  activeSourceId?: string;
  /** v1.6.1 — number of clips currently on the timeline. The LLM uses
   *  this to choose between "edit" and "extract" for time-bound asks. */
  highlightsCount?: number;
  /** v1.6.1 — id of the clip the user has selected on the timeline.
   *  Lets "split this clip" / "drop the selected clip" resolve cleanly. */
  selectedClipId?: string | null;
  /** v1.6.4 — compact list of clips currently on the timeline so the
   *  planner can resolve phrases like "clip 2" / "this clip" to a
   *  clipId for describe / edit modes. Indexed in display order. */
  timelineClips?: Array<{
    id: string;
    start: number;
    end: number;
    sourceId?: string;
    label?: string;
  }>;
  /** Cross-turn memory chips. */
  memory?: SessionMemory;
  /** Compact summary of recent activity events for the planner.
   *  Built client-side via `summarizeRecentActivity()`. Keeps the prompt
   *  small while letting the LLM reason about implicit user preferences. */
  recentActivity?: string;
  /** v1.7.2 — When the user has just received a briefing card, the
   *  client passes the structured best parts here so the planner can
   *  reference them by id ("clip part 02", "use the third one") and
   *  emit `mode: "promote"`. Omitted when there's no recent briefing
   *  in scope. The client's lastBriefing slot is the source of truth. */
  lastBriefing?: {
    sourceId: string;
    sourceName?: string;
    bestParts: Array<{
      id: string;
      startSeconds: number;
      endSeconds: number;
      label: string;
      why: string;
    }>;
  };
  /** v1.3.0 — classified user tier (novice | advanced). Lets the
   *  planner bias mode/strategy toward what the prompt actually
   *  signals about the user's experience level. */
  userTier?: UserTier;
}

/** Discriminated union returned by POST /api/agent. */
export type AgentResponse =
  | {
      mode: "plan";
      /** Fully resolved plan (after any merge against currentPlan). */
      plan: EditPlan;
      /** Patch the planner emitted, if this was a refinement turn. */
      planPatch?: PlanPatch;
      /** Conversational message to render in chat. */
      message: string;
      /** v1.4.0 — user tier classified by the LLM from tone/vocabulary.
       *  Persisted client-side and forwarded into the pipeline so the
       *  same widen-or-narrow decision drives every selection step. */
      userTier?: UserTier;
      /** Fields filled by inference; UI surfaces these as overridable chips. */
      inferred: InferredField[];
      /** Soft warnings (e.g., "fell back to Groq"). */
      warnings: string[];
      /** Soft-tier global quota state (banner trigger). Present when fraction > softThreshold. */
      quotaWarning?: { usage: number; limit: number; fraction: number };
    }
  | {
      mode: "moment";
      /** Single-target plan with exactly one scenario. */
      plan: EditPlan;
      planPatch?: PlanPatch;
      /** Verbatim moment description from the user. */
      momentDescription: string;
      message: string;
      /** v1.4.0 — see plan branch. */
      userTier?: UserTier;
      inferred: InferredField[];
      warnings: string[];
      quotaWarning?: { usage: number; limit: number; fraction: number };
    }
  | {
      mode: "extract";
      /** Verbatim time slice — the pipeline emits exactly one Highlight
       *  for this range without sampling, scoring, or hitting the
       *  cloud at all. v1.5.0. */
      extractRange: ExtractRange;
      message: string;
      inferred: InferredField[];
      warnings: string[];
      quotaWarning?: { usage: number; limit: number; fraction: number };
      /** Optional plan that may carry across to follow-up turns. */
      plan?: EditPlan;
    }
  | {
      /** v1.6.1 — direct timeline edit. The client applies each
       *  operation sequentially using the existing store actions. The
       *  pipeline does NOT run on this turn — these are pure local
       *  mutations of the highlights array. */
      mode: "edit";
      operations: EditOperation[];
      message: string;
      inferred: InferredField[];
      warnings: string[];
      quotaWarning?: { usage: number; limit: number; fraction: number };
    }
  | {
      /** v1.6.4 — clip-level Q&A. The user asked the AI editor to look
       *  at a specific clip and answer a question about it. The client
       *  resolves the target into a (sourceId, start, end) range,
       *  extracts ~6 frames, and calls /api/vision/clip with the
       *  question. The vision response is then pushed back into chat
       *  as the assistant message. The plan + clip state stay
       *  untouched on this turn. */
      mode: "describe";
      /** Which clip / range the question is about. The LLM emits ONE
       *  of these — clipId is preferred when the user is clearly
       *  pointing at a timeline clip ("this clip", "the selected
       *  one", or by index "clip 2"); the explicit range is used when
       *  the user gave a time window directly ("describe 0:30 to
       *  0:45"). */
      target:
        | { kind: "clip"; clipId: string }
        | {
            kind: "range";
            sourceId?: string;
            startSeconds: number;
            endSeconds: number;
          };
      /** The user's verbatim question, forwarded to the vision call. */
      question: string;
      /** Short, warm one-liner shown in chat WHILE the vision call is
       *  in flight. The actual answer arrives as a follow-up message. */
      message: string;
      inferred: InferredField[];
      warnings: string[];
      quotaWarning?: { usage: number; limit: number; fraction: number };
    }
  | {
      /** v1.7.2 — promote briefing best parts into actual timeline
       *  clips. The user has previously seen a briefing card and is
       *  now asking us to "use those moments" / "clip those" / "make
       *  a 30s reel of them". The client reads its stored
       *  lastBriefing.bestParts (each already carries a precise
       *  start/end on the source video, courtesy of the prior vision
       *  call) and converts them directly to highlights via
       *  mergeHighlights. NO SigLIP scoring; NO new vision call.
       *  This is the path that makes the briefing's identified
       *  moments first-class clips instead of throwaway data. */
      mode: "promote";
      /** Specific best-part IDs to promote. Empty / undefined means
       *  "all of them". When provided, only the matching parts from
       *  lastBriefing are kept. */
      partIds?: string[];
      /** When set, trim the result to fit this many seconds total.
       *  Sets userSpecifiedDuration = true downstream. The trim picks
       *  highest-confidence (briefing-order) parts first. */
      targetSeconds?: number;
      /** "append" (default) preserves existing timeline clips and
       *  folds the briefing parts in. "replace" wipes the timeline
       *  first — used when the user said "actually let's use those
       *  instead". */
      op?: "append" | "replace";
      message: string;
      inferred: InferredField[];
      warnings: string[];
      quotaWarning?: { usage: number; limit: number; fraction: number };
    }
  | {
      /** v1.7.0 — descriptive briefing. The user asked the AI to look
       *  at the video and *describe* it / call out best parts WITHOUT
       *  producing a render. The planner returns a sample plan; the
       *  client samples those frames and POSTs them to
       *  /api/agent/briefing for the actual structured analysis.
       *  Pipeline does NOT run. Plan + clip state stay untouched. */
      mode: "briefing";
      /** The user's verbatim question, forwarded to the vision call. */
      question: string;
      /** Frame-sampling instructions for the client. Range is optional
       *  — omitted means "whole active video". Count is the desired
       *  number of frames; client may sample fewer if the range is short. */
      samplePlan: {
        count: number;
        range?: { startSeconds: number; endSeconds: number };
      };
      /** Short, warm one-liner shown in chat WHILE the vision call
       *  is in flight. The structured answer arrives separately and
       *  is rendered as a BriefingCard attachment. */
      message: string;
      inferred: InferredField[];
      warnings: string[];
      quotaWarning?: { usage: number; limit: number; fraction: number };
    }
  | {
      mode: "clarify";
      message: string;
      /** 1–2 questions to ask before running the pipeline. */
      questions: ClarifyQuestion[];
      warnings: string[];
      quotaWarning?: { usage: number; limit: number; fraction: number };
    }
  | {
      /** v1.5.2 — context-update turn. The user is informing the AI
       *  about the footage ("there's a defeated title", "this is 4K",
       *  "the audio is bad", "this is from a podcast") rather than
       *  asking for a new plan. The assistant just confirms it heard
       *  and the existing plan / clips stay untouched. */
      mode: "acknowledge";
      message: string;
      /** Optional inferred fields the planner extracted from the note
       *  (e.g., field="avoid", value="defeat title cards"). The UI may
       *  surface these as overridable chips. */
      inferred: InferredField[];
      warnings: string[];
      quotaWarning?: { usage: number; limit: number; fraction: number };
    }
  | {
      mode: "error";
      error: string;
      /** True when the error is transient (overload, network) and a retry helps. */
      transient?: boolean;
      /** Set when rate-limited; UI uses this to show a friendly retry banner. */
      retryAfterSeconds?: number;
    };

// ---------------------------------------------------------------------
// Adaptive selection (NEW in v1.3.0)
// ---------------------------------------------------------------------

/** v1.4.0 — distinguishes beginners from pros. The chat planner emits
 *  this directly via structured JSON; no client- or server-side regex
 *  classification anymore. Used by the pipeline to widen the candidate
 *  net for novices and respect specificity for advanced users. */
export type UserTier = "novice" | "advanced";

/** v1.3.0 — frame-score distribution summary. Powers adaptive selection. */
export interface ScoreStats {
  count: number;
  max: number;
  mean: number;
  p50: number;
  p75: number;
  p90: number;
}

// ---------------------------------------------------------------------
// Activity log (NEW in v1.2.0)
// ---------------------------------------------------------------------

export type ActivityActor = "user" | "ai" | "system";

/** Open string union for kinds — strings only, with a documented set in
 *  `lib/log/types.ts`. Using a string type lets components log new kinds
 *  without first amending the type. */
export type ActivityKind = string;

export interface ActivityEvent {
  id: string;
  sessionId: string;
  /** Wall-clock timestamp in ms (most recent occurrence when `count > 1`). */
  ts: number;
  actor: ActivityActor;
  kind: ActivityKind;
  /** Free-form payload; see `lib/log/types.ts` for documented shapes. */
  payload: Record<string, unknown>;
  /** Duration of the action when known, in ms. */
  ms?: number;
  /** When > 1, this row was deduped from N consecutive identical events. */
  count?: number;
  /** Pre-rendered one-line summary for drawers and planner prompts. */
  summary?: string;
}

// ---------------------------------------------------------------------
// Rate limit responses (NEW in v1.2.0)
// ---------------------------------------------------------------------

export interface RateLimitDecision {
  allowed: boolean;
  reason?: string;
  status?: 429 | 503;
  retryAfterSeconds?: number;
  /** "ok" | "soft" → request allowed; "hard" → rejected by global guard. */
  tier?: "ok" | "soft" | "hard";
  /** Used quota across the layer that decided. */
  usage?: number;
  limit?: number;
}



// ---------------------------------------------------------------------
// v1.7.0 — Briefing mode (structured "describe the whole video")
// ---------------------------------------------------------------------

/** One "best part" picked by the briefing endpoint. Used to render
 *  the BriefingCard's clickable highlight list. */
export interface BestPart {
  /** Stable id so the card can key list items + handle navigation. */
  id: string;
  startSeconds: number;
  endSeconds: number;
  /** One-line title — what the moment is. */
  label: string;
  /** One-sentence reason this part stands out. */
  why: string;
  /** When known, the source id this part is in. Omitted in single-source
   *  briefings (defaults to the active source). */
  sourceId?: string;
}

/** Structured response from POST /api/agent/briefing. */
export interface BriefingResult {
  /** 2-3 sentence overall description. */
  overview: string;
  /** Up to 5 best moments. May be empty if the model couldn't find any
   *  (e.g., the video is uniform / blank), in which case the UI falls
   *  back to the overview only. */
  bestParts: BestPart[];
  /** Suggested next user actions, generated from the briefing content
   *  ("Make a 30s reel of these moments", "Show me clip 2", etc.).
   *  Up to 4. The chat surface renders these as one-tap buttons. */
  followUps: string[];
}

// ---------------------------------------------------------------------
// v1.7.0 — Persistent memory facts
// ---------------------------------------------------------------------

/**
 * One extracted fact remembered across turns. Stored server-side under
 * the iron-session sid and injected into the planner prompt as a
 * "What I remember" block on every subsequent turn.
 *
 * Facts are extracted by the planner itself via the `factsToRemember`
 * field in its JSON output — no separate extraction call. This keeps
 * memory free in token cost (the planner is already running) and
 * grounded in the same context that produced the response.
 */
export interface MemoryFact {
  id: string;
  /** When the fact was first extracted (ms epoch). */
  ts: number;
  /** Most recent turn that reinforced this fact. Drives recency-based
   *  retrieval ranking. Equal to ts on creation. */
  lastSeen: number;
  /** Coarse classifier so retrieval can prioritise certain kinds for
   *  certain prompt slots (e.g., "intent" facts always inject before
   *  "preference" facts). */
  kind: "intent" | "preference" | "context" | "constraint" | "feedback";
  /** Short snake_case identifier — e.g., "prefers_briefing_over_render". */
  subject: string;
  /** The fact value. Primitive or short string array. */
  value: string | number | boolean | string[];
  /** "explicit" — user said it directly; "inferred" — model inferred it
   *  from context; "feedback" — derived from a thumbs-up/down or
   *  follow-up correction. */
  source: "explicit" | "inferred" | "feedback";
  /** 0..1, the planner's confidence at extraction time. Decays slightly
   *  per turn the fact isn't reinforced. */
  confidence: number;
  /** Optional one-sentence justification, surfaced in the UI's "what
   *  I remember" reveal so the user understands WHY the fact is there. */
  reason?: string;
}

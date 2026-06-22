// =====================================================================
// Shared types — single source of truth for the whole app.
// =====================================================================

import type { BoundaryTransition } from "./transitions/types";
import type { ConstraintGraph } from "./constraints/types";

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
  /** v2.6 — CONSTRAINT-FIRST editing. The compiled constraint graph that
   *  drives the hard gate (lib/constraints/*). When present AND
   *  constraint-driven (a hard include or any exclude), the pipeline filters
   *  frames to the constraint BEFORE scoring/selection and never falls back
   *  to generic highlights. Absent / soft → legacy behaviour unchanged. */
  constraints?: ConstraintGraph;
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
  /** v2.7 — smart-reframe focal point (0..1 fraction of frame width/height)
   *  marking where motion / visual contrast sits. Drives the vertical/square
   *  crop position. Defaults to 0.5 (center) when absent. */
  focusX?: number;
  focusY?: number;
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
  /** v2.7 — smart-reframe focal point (0..1) used to POSITION the
   *  vertical/square crop window on the subject instead of the frame
   *  center. Aggregated from the clip's frames. Absent → 0.5 (center). */
  focusX?: number;
  focusY?: number;
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

// ---------------------------------------------------------------------
// Project history restore (v2.1) — persistent source manifest
// ---------------------------------------------------------------------

/**
 * Persisted record of one source in a project. Stored in the session
 * snapshot so a restored project remembers EXACTLY which uploads it used
 * (by hash + metadata) without keeping the heavy video bytes. The blob and
 * object URL are deliberately NOT here — they cannot survive a reload, so
 * the user re-uploads the same file and we reconnect it by `hash`.
 *
 * `status` is the source's availability AT SAVE TIME ("available" = a live
 * blob was attached; "missing" = it was a placeholder awaiting re-upload).
 * It is a hint only — on the NEXT load every source starts missing until
 * re-uploaded, because we never persist blobs by default.
 */
export interface PersistedSourceManifest {
  id: string;
  hash: string;
  meta: VideoSourceMeta;
  addedAt: number;
  /** Filename last seen for this source — a display hint, NEVER an
   *  identity key (filenames are weak; the hash is the source of truth). */
  lastKnownName: string;
  status?: "missing" | "available";
}

/**
 * A restored source whose bytes are not (yet) in memory. The timeline can
 * still reference it by `id`; the UI shows a "re-upload to restore"
 * placeholder. It carries `missing: true` so the union with a hydrated
 * `VideoSource` is unambiguous. No `blob`/`url` — by construction it never
 * creates an object URL.
 */
export interface RestoredSourcePlaceholder {
  id: string;
  hash: string;
  meta: VideoSourceMeta;
  addedAt: number;
  missing: true;
}

/** A union of "have the bytes" vs "need a re-upload". Kept as a type for
 *  call sites that want to treat both uniformly (display, identity). The
 *  store holds the two states in separate arrays for change-detection
 *  simplicity, but this models the conceptual relationship. */
export type ProjectSource =
  | (VideoSource & { status?: "available"; missing?: false })
  | RestoredSourcePlaceholder;



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
  | "needs_review"
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
  /** v2.1 — full persistent source manifest (metadata + hash + last name +
   *  availability). Supersedes `sources` for restore; `sources` is still
   *  written for backward-compatible readers. */
  sourceManifests?: PersistedSourceManifest[];
  /** v1.6.0 — IDs of sources the user had selected for AI use at save time. */
  selectedSourceIds?: string[];
  /** v1.6.0 — which source was active in the preview pane. */
  activeSourceId?: string;
  plan?: EditPlan;
  memory: SessionMemory;
  highlights: Highlight[];
  /** v2.1 — clip selected on the timeline at save time. */
  selectedClipId?: string | null;
  /** v2.1 — per-boundary transitions at save time. */
  boundaryTransitions?: BoundaryTransition[];
  /** v2.1 — how the next pipeline run should join the timeline. */
  pendingTimelineOp?: "append" | "replace";
  /** v2.1 — a plan was awaiting a "Run analysis" confirmation. */
  pendingExecution?: boolean;
  messages: ChatMessage[];
  status: JobStatus;
  progress: number;
  /** Most recent intent the planner classified for this session. */
  mode?: IntentMode;
  /** v2.1 — inferred fields surfaced as chips at save time. */
  inferred?: InferredField[];
  /** v2.1 — classified user tier at save time. */
  userTier?: UserTier;
  /** v2.1 — most recent briefing (safe to restore: ids + ranges only). */
  lastBriefing?: {
    id: string;
    sourceId: string;
    sourceName?: string;
    bestParts: BestPart[];
    ts: number;
  } | null;
  /** v2.1 — schema version. Absent / 1 = legacy; 2 = full project restore. */
  schemaVersion?: 1 | 2;
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
  /** v1.7.3 — Local-ASR (Whisper) tier. "off" means transcription is
   *  unavailable on this device (missing Worker / Web Audio / etc).
   *  "low" / "mid" / "high" pick smaller / larger Whisper variants. */
  audioTier: AudioTier;
}

/** v1.7.3 — local audio model tier. */
export type AudioTier = "high" | "mid" | "low" | "off";

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
  | "merge"
  | "compose"
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
    }
  | {
      /** v1.7.9 — Restore the timeline to its state before the most
       *  recent timeline mutation. One-step undo. Global (not scoped to
       *  a source); sourceId is ignored if present. The client maps
       *  "undo" / "undo that" / "bring those back" / "put it back" to
       *  this op so a destructive turn is always recoverable. */
      kind: "undo";
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

// ---------------------------------------------------------------------
// Multi-source compose (montage) — v1.8.0
// ---------------------------------------------------------------------

/**
 * How a compose source selection points at a library source. The planner
 * emits one of these per requested source; the CLIENT resolves it against
 * the live library (where ids/order/active/selected are authoritative).
 *
 *   "id"            — exact VideoSource.id (preferred when the planner is
 *                     confident from the library block).
 *   "index"         — 0-based library position. "first video" → 0,
 *                     "second video" → 1, "third" → 2.
 *   "active"        — the source currently in the preview pane.
 *   "selected"      — the (first) source ticked for AI use.
 *   "filename_hint" — match `hint` against the source filename/title.
 *   "semantic_hint" — match `hint` against filename + per-source notes
 *                     ("the joke upload", "the gameplay one").
 */
export type ComposeSourceRefType =
  | "active"
  | "selected"
  | "index"
  | "id"
  | "filename_hint"
  | "semantic_hint";

export interface ComposeSourceRef {
  type: ComposeSourceRefType;
  /** 0-based library index for type "index". */
  index?: number;
  /** VideoSource.id for type "id". */
  sourceId?: string;
  /** Free-text hint for filename_hint / semantic_hint. */
  hint?: string;
}

/** The narrative role a source's clips play in the montage. Drives the
 *  story_arc ordering and the dynamic transition selection. */
export type ComposeRole =
  | "main"
  | "insert"
  | "segment"
  | "intro"
  | "middle"
  | "ending";

/** One source's contribution to a compose montage: which source, what to
 *  find in it, and how much of it to take. */
export interface ComposeSourceSelection {
  sourceRef: ComposeSourceRef;
  /** What to look for in THIS source ("combat moments", "cutscene",
   *  "the funny part", "ingredient shots"). Empty / "best"-style text
   *  means "visually busiest moments" (semantic pass skipped). */
  query: string;
  role?: ComposeRole;
  /** 0-based user-mentioned order ("first … then …"). Lower comes first
   *  under the user_mentioned_order ordering. */
  order?: number;
  /** Max clips to take from this source. Optional. */
  clipCount?: number;
  /** Approximate seconds to take from this source. Optional. */
  durationSeconds?: number;
}

/** How the per-source clips are arranged into the final montage. */
export type ComposeOrderingType =
  | "source_order"
  | "user_mentioned_order"
  | "interleave"
  | "shuffle"
  | "story_arc"
  | "energy_curve";

export interface ComposeOrdering {
  type: ComposeOrderingType;
  /** Pin the lead clip to the very front, then apply the ordering to the
   *  rest ("first video should start first, then shuffle the rest"). */
  anchorFirst?: boolean;
}

/**
 * Transition vocabulary the planner may request. NOTE: the render worker
 * only supports `none | fade | crossfade`. Richer types (glitch / whip /
 * zoom / match_cut) are accepted for intent capture and mapped DOWN to the
 * closest renderable transition by `resolveComposeTransition` — we never
 * claim to render an effect we can't.
 */
export type ComposeTransitionType =
  | "auto"
  | "cut"
  | "fade"
  | "crossfade"
  | "glitch"
  | "whip"
  | "zoom"
  | "match_cut";

export interface ComposeTransition {
  type: ComposeTransitionType;
  durationSeconds?: number;
  /** Free-text rule for dynamic per-boundary selection. */
  dynamicRule?: string;
}

/**
 * v1.8.0 — A multi-source montage request. The user referenced clips from
 * MORE THAN ONE uploaded video and asked to combine them ("combat in the
 * first video and cutscene in the second, make it transition"). The client
 * resolves each source, runs REAL per-source vision scoring, then assembles
 * a fresh ordered montage onto the timeline. Original uploads are never
 * mutated; the previous timeline is recoverable via undoTimeline.
 */
export interface MultiSourceComposePlan {
  /** Where the assembled montage goes. Option A always targets the single
   *  shared timeline (a fresh "AI Combined" run); the field is kept
   *  explicit so a future true multi-slot mode can extend it. */
  outputTarget: {
    type: "new_timeline_slot";
    /** Visible run label, e.g. "AI Combined 1" / "Combined Montage". */
    name?: string;
  };
  sources: ComposeSourceSelection[];
  ordering: ComposeOrdering;
  transition: ComposeTransition;
  /** Total montage length the user named, if any. */
  targetSeconds?: number;
  userSpecifiedDuration?: boolean;
  /** v1.9.x (issue #64) — which uploads to combine.
   *    "explicit" (default) → use the enumerated `sources` (per-source picks).
   *    "all"               → fan out across EVERY eligible upload; the client
   *                          expands `sources` from the live library at run
   *                          time (the server can't enumerate the library). */
  sourceScope?: "all" | "explicit";
  /** Output aspect the user asked for (vertical/horizontal/square). Drives
   *  the render aspect; absent → derive from the source. */
  format?: "vertical" | "horizontal" | "square";
  /** Minimum total clips the user asked for ("at least 5 clips"). Soft — the
   *  client tries to meet it and reports honestly if it can't. Never a
   *  fabricated default. */
  minClipCount?: number;
  /** True when an all-source compose has NO concrete subject ("combine all
   *  into a 2 min reel"): each source uses broad visual-interest selection
   *  (motion + saliency), not a fabricated semantic topic. */
  genericBestParts?: boolean;
  /** For an all-source compose WITH a real subject ("cooking from all
   *  videos"): the shared query applied to every source. */
  allSourcesTopic?: string;
  /** True when per-source clip selection needs the vision pipeline (the
   *  common case for semantic queries like "combat" / "jokes"). */
  needsAnalysis: boolean;
}

/** Discriminated union returned by POST /api/agent. */
export type AgentResponse =
  | {
      mode: "plan";
      /** Fully resolved plan (after any merge against currentPlan). */
      plan: EditPlan;
      /** Patch the planner emitted, if this was a refinement turn. */
      planPatch?: PlanPatch;
      /** v1.7.9 — how the run's results join the timeline.
       *    "append"  → keep existing clips, fold the new ones in (default)
       *    "replace" → wipe the timeline first
       *  Omitted means "let the client decide": it appends when the
       *  timeline already has clips and replaces when it's empty. The
       *  planner only sets "replace" on explicit reset language
       *  ("start over", "scrap that", "instead make it…"). This is what
       *  stops a second prompt from silently erasing the first run's
       *  clips. */
      op?: "append" | "replace";
      /** Conversational message to render in chat. */
      message: string;
      /** v1.9.x — when true, the client runs the analysis pipeline
       *  immediately instead of showing a "Run analysis" confirm button.
       *  Set by the server for actionable, direct-command plans when a
       *  video source exists. The Run button remains as a manual fallback
       *  for non-actionable / no-video cases. */
      autoRun?: boolean;
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
      /** v1.7.9 — see the plan variant. Default behaviour appends the
       *  located moment to existing clips ("also find the save")
       *  instead of replacing the timeline. */
      op?: "append" | "replace";
      /** Verbatim moment description from the user. */
      momentDescription: string;
      message: string;
      /** v1.9.x — auto-run the pipeline (see the plan variant). */
      autoRun?: boolean;
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
      /** v1.7.9 — how the extracted slice joins the timeline. Default
       *  (omitted) appends to existing clips so "clip 0:30–1:00" then
       *  "clip 2:00–2:30" stacks both instead of the second wiping the
       *  first. "replace" only on explicit reset language. */
      op?: "append" | "replace";
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
      /** v1.7.4 — verbatim multi-source merge. The user wants to
       *  concatenate whole videos with no editing, no scoring, no
       *  clipping. Triggered by phrases like "just merge", "stitch",
       *  "join the videos", "use the full videos". The pipeline does
       *  NOT run; the client converts each selected source into a
       *  single full-duration Highlight and lays them on the timeline
       *  in order. The user then taps Render to assemble.
       *
       *  Distinct from `extract` mode (single source, named time
       *  range) and from `plan` mode (scored multi-clip selection).
       *  This is the simplest possible operation and previously had
       *  no first-class intent — users would say "merge" and the
       *  planner would clarify or run a scoring pipeline that
       *  produced tiny snippets. */
      mode: "merge";
      /** Source ids to include, in concatenation order. When omitted
       *  or empty, the client uses every currently-selected source
       *  (selectedSourceIds) in their library order. */
      sourceIds?: string[];
      /** Transition between clips. Default "none" — users who say
       *  "no edit / no effects" expect a clean cut. */
      transition?: "none" | "fade" | "crossfade";
      /** Output framing preference. When omitted the renderer falls
       *  back to the first source's native aspect. */
      format?: "vertical" | "horizontal" | "square";
      /** "replace" (default) wipes any existing timeline clips before
       *  laying down the merge. "append" preserves them. */
      op?: "replace" | "append";
      message: string;
      inferred: InferredField[];
      warnings: string[];
      quotaWarning?: { usage: number; limit: number; fraction: number };
    }
  | {
      /** v1.8.0 — multi-source compose / montage. The user referenced
       *  clips from MORE THAN ONE uploaded video and asked to combine
       *  them ("combat in the first video and the cutscene in the
       *  second, make it transition"; "intro from first, funny bit from
       *  second, ending from third"). Distinct from `merge` (whole
       *  videos, no scoring) and `plan` (one fused reel from the
       *  selected library): compose keeps each source's pick SEPARATE,
       *  then arranges them in a user-controlled ORDER with transitions.
       *
       *  The client resolves each source ref, runs the REAL per-source
       *  vision pipeline (no faked frames), assembles a fresh ordered
       *  montage, and lays it on the timeline via setHighlights — which
       *  snapshots the prior timeline for one-tap undo. Original uploads
       *  are never modified. */
      mode: "compose";
      compose: MultiSourceComposePlan;
      /** v1.8.0 — run the per-source analysis immediately (the client
       *  does this whenever sources resolve + a video exists; the flag is
       *  informational, mirroring plan/moment). */
      autoRun?: boolean;
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

/**
 * v1.8.1 — Structured briefing follow-up action.
 *
 * The old model returned follow-ups as plain strings, so a button click
 * became raw chat text and the planner had to RE-GUESS the user's intent
 * from words every time ("Make a reel of these" → ?). That round-trip is
 * exactly why briefing chips felt prototype-level and occasionally fell
 * into a generic clarify loop.
 *
 * A `BriefingFollowUp` instead CARRIES the intent. The UI knows whether a
 * chip should promote briefing parts, plan a topic, extract an exact
 * range, or just send chat — so the deterministic path can run without
 * asking the cloud planner to interpret a sentence.
 *
 * Backward compatibility: `BriefingResult.followUps` still accepts plain
 * strings (the briefing API and older saved sessions emit those). They are
 * normalized into this union client-side via
 * `normalizeBriefingFollowUps()` before rendering — never with a brittle
 * keyword table, just a small generic "use these moments" heuristic with a
 * `plan_topic` default.
 */
export type BriefingFollowUp =
  | {
      /** Stable id for React keys + logging. */
      id: string;
      /** Button text shown to the user. */
      label: string;
      /** Lift the briefing's already-found best parts onto the timeline.
       *  Deterministic — no cloud planner, no new vision call. */
      kind: "promote";
      /** Optional subset of best-part ids; omitted = all of them. */
      partIds?: string[];
      /** Optional total-duration budget to trim the promoted parts to. */
      targetSeconds?: number;
      /** Append (default) preserves existing clips; replace wipes first. */
      op?: "append" | "replace";
    }
  | {
      id: string;
      label: string;
      /** Build a highlight plan about a concrete subject the chip names.
       *  Produces an EditPlan + pending execution WITHOUT asking the
       *  planner to interpret raw text. */
      kind: "plan_topic";
      /** Which briefing/source this topic is grounded in. */
      sourceId: string;
      /** Short topic label (== label by default). */
      topic: string;
      /** The scenario prompt fed to the scorer. */
      scenarioPrompt: string;
      /** Signal-fusion weights; defaults to a semantic-heavy profile. */
      signals?: { semantic: number; motion: number; saliency: number };
    }
  | {
      id: string;
      label: string;
      /** Grab an EXACT time slice deterministically (no scoring/cloud). */
      kind: "extract_range";
      sourceId: string;
      startSeconds: number;
      endSeconds: number;
    }
  | {
      id: string;
      label: string;
      /** Plain chat — send `text` through the normal assistant pipe. This
       *  preserves the legacy "click chip → chat" behavior for anything we
       *  can't map to a deterministic action. */
      kind: "chat";
      text: string;
    };

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
   *  Up to 4. The chat surface renders these as one-tap buttons.
   *
   *  v1.8.1 — may be plain strings (legacy / current briefing API output)
   *  OR structured `BriefingFollowUp` actions. Strings are normalized into
   *  actions client-side before rendering; both shapes round-trip safely
   *  through session persistence. */
  followUps: Array<string | BriefingFollowUp>;
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

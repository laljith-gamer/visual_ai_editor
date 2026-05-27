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
  /** Final short duration target in seconds. */
  targetShortSeconds: number;
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
  /** Optional human-readable explanation from the planner. */
  rationale?: string;
}

/** A scored frame from the per-frame pass. */
export interface FrameScore {
  /** Frame timestamp in seconds. */
  t: number;
  /** Aggregate score after applying labelWeights. */
  score: number;
  /** Per-label raw scores (debug + UI). */
  labels: Record<string, number>;
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
}

// ---------------------------------------------------------------------
// Session, memory, history
// ---------------------------------------------------------------------

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

/** Three intent modes the planner can return. See
 *  .kiro/steering/conversation-patterns.md for the full policy. */
export type IntentMode = "plan" | "moment" | "clarify";

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

/** What POST /api/agent expects in the request body. */
export interface AgentRequest {
  /** Full conversation history. The latest user turn is the last item. */
  messages: ChatMessage[];
  /** The currently-active plan, if any. Enables refinement turns. */
  currentPlan?: EditPlan | null;
  /** Source video metadata for inference. */
  videoMeta?: {
    duration: number;
    width: number;
    height: number;
  };
  /** Cross-turn memory chips. */
  memory?: SessionMemory;
  /** Compact summary of recent activity events for the planner.
   *  Built client-side via `summarizeRecentActivity()`. Keeps the prompt
   *  small while letting the LLM reason about implicit user preferences. */
  recentActivity?: string;
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
      mode: "error";
      error: string;
      /** True when the error is transient (overload, network) and a retry helps. */
      transient?: boolean;
      /** Set when rate-limited; UI uses this to show a friendly retry banner. */
      retryAfterSeconds?: number;
    };

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

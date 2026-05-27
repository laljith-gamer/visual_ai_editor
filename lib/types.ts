// =====================================================================
// Shared types — single source of truth for the whole app
// =====================================================================

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
  /** Map: scenario id → desired weight contribution (0–1). */
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

/** Memory chips persisted across edits in a session. */
export interface SessionMemory {
  duration?: number;
  format?: EditPlan["format"];
  styles: string[];
  keep: string[];
  skip: string[];
}

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
}

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

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  /** Attached structured data (a plan, an error, etc.) */
  attachment?: Record<string, unknown>;
}

/** Capability tier detected at startup. */
export type CapabilityTier = "high" | "mid" | "low";

export interface Capability {
  tier: CapabilityTier;
  hasWebGPU: boolean;
  hasSharedArrayBuffer: boolean;
  deviceMemoryGB: number;
  hardwareConcurrency: number;
  isMobile: boolean;
}

/** Predictions cache entry (per video + scenario signature). */
export interface PredictionsCacheEntry {
  videoHash: string;
  scenarioSignature: string;
  sampleEverySeconds: number;
  frames: FrameScore[];
  createdAt: number;
}

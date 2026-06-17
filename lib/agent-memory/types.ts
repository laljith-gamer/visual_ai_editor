/**
 * Phase 2 — agent internal memory types.
 *
 * This is the agent's OWN observed/working memory, distinct from:
 *   - the server-side planner `MemoryFact` store (lib/memory/*), which is
 *     about cross-session preferences injected into the LLM prompt, and
 *   - the dormant `video-memory` tree (lib/video-memory/*), which is about
 *     per-source frame/scene structure.
 *
 * Agent memory is LOCAL-FIRST and runtime: it captures what the user has
 * STATED, what the agent has OBSERVED, the current editing FLOW (active
 * source, last clip, pending placement), and REINFORCEMENT (liked /
 * rejected ranges, sources, concepts). Every observed record carries a
 * confidence (0..1) and a one-line `evidence` string — never a silent
 * fact. User-stated facts live separately from observed ones (the `kind`
 * field) so a direct instruction always outranks an inference.
 */

export type MemoryKind =
  | "user_stated"
  | "observed"
  | "flow"
  | "source"
  | "clip"
  | "reinforcement"
  | "preference";

export type MemorySource =
  | "user"
  | "agent"
  | "timeline"
  | "vision"
  | "transcript"
  | "ocr"
  | "system";

export type MemoryScope = "session" | "source" | "clip" | "project";

export interface AgentMemoryRecord {
  id: string;
  kind: MemoryKind;
  /** Stable key — same key reinforces / overwrites rather than duplicating
   *  (e.g. "avoid:intro", "prefers:action", "source_use:src_123"). */
  key: string;
  value: unknown;
  /** 0..1. Observed records start lower; user-stated records start high. */
  confidence: number;
  /** One-line human-readable justification. Required — no silent memory. */
  evidence: string;
  source: MemorySource;
  scope: MemoryScope;
  sourceId?: string;
  clipId?: string;
  createdAt: number;
  updatedAt: number;
  /** Optional expiry (ms epoch). Flow memory may be short-lived. */
  expiresAt?: number;
}

/** Short-lived working memory of the current editing flow. Drives
 *  anaphora resolution ("it" / "that" / "again") and implicit source
 *  selection when the user doesn't name one. */
export interface FlowMemory {
  activeGoal?: string;
  activeSourceId?: string;
  lastMentionedSourceId?: string;
  lastMentionedConcept?: string;
  lastCreatedClipIds: string[];
  lastSelectedClipId?: string;
  lastOperation?: string;
  /** A placement the next add should honour ("after that"). Stored as
   *  the structured spec from lib/intent so the orchestrator can apply
   *  it without re-parsing. Typed loosely to avoid a hard import cycle. */
  pendingPlacement?: unknown;
}

/** Reinforcement signals accumulated from user feedback. Drives scoring
 *  adjustments (boost liked, penalize rejected) and source preference. */
export interface ReinforcementMemory {
  rejectedClipIds: string[];
  likedClipIds: string[];
  rejectedRanges: Array<{ sourceId?: string; start: number; end: number }>;
  likedRanges: Array<{ sourceId?: string; start: number; end: number }>;
  likedConcepts: string[];
  rejectedConcepts: string[];
  preferredSourceIds: string[];
  avoidedSourceIds: string[];
  /** Free-text style hints ("more action", "less slow", "avoid intro"). */
  styleHints: string[];
}

export function emptyReinforcement(): ReinforcementMemory {
  return {
    rejectedClipIds: [],
    likedClipIds: [],
    rejectedRanges: [],
    likedRanges: [],
    likedConcepts: [],
    rejectedConcepts: [],
    preferredSourceIds: [],
    avoidedSourceIds: [],
    styleHints: []
  };
}

export function emptyFlow(): FlowMemory {
  return { lastCreatedClipIds: [] };
}

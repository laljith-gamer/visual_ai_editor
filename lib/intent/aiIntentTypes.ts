// =====================================================================
// lib/intent/aiIntentTypes.ts
//
// Shared types for the unified AI intent router. These define the
// structured contract between the AI classifier and the executor.
//
// The AI router returns ONE of these actions with typed parameters.
// The executor maps them directly to store mutations — no regex
// parsing, no keyword matching, no word lists.
// =====================================================================

/** Every action the editor can perform, classified by the AI router. */
export type AIAction =
  // Timeline mutations
  | "add_clip"
  | "remove_clip"
  | "move_clip"
  | "trim_clip"
  | "extend_clip"
  | "replace_clip"
  | "split_clip"
  // Creation / analysis
  | "create_highlight"
  | "find_moment"
  | "describe_video"
  | "scan_video"
  // Multi-source
  | "merge_videos"
  | "compose_montage"
  // Timeline-wide
  | "trim_to_target"
  | "refine_timeline"
  // Transitions
  | "set_transition"
  | "auto_transitions"
  | "remove_transitions"
  // Control
  | "render"
  | "export"
  | "undo"
  | "redo"
  // Tool commands
  | "set_format"
  | "select_source"
  | "switch_source"
  // Conversation
  | "confirm_pending"
  | "cancel_pending"
  | "answer_question"
  | "chat"
  | "read_only_question"
  // Fallback
  | "clarify"
  | "passthrough"
  | "unavailable";

/** Time range extracted by the AI from natural language. */
export interface AITimeRange {
  kind: "first" | "last" | "middle" | "absolute" | "relative";
  startSeconds?: number;
  endSeconds?: number;
  durationSeconds?: number;
}

/** Source reference extracted by the AI. */
export interface AISourceRef {
  type: "index" | "name" | "active" | "all" | "selected";
  index?: number;
  name?: string;
}

/** Clip reference extracted by the AI. */
export interface AIClipRef {
  type: "index" | "first" | "last" | "selected" | "all";
  index?: number;
}

/** Transition type the user requested. */
export type AITransitionType =
  | "cut" | "fade" | "crossfade" | "dissolve"
  | "dip_to_black" | "slide" | "zoom" | "glitch" | "whip"
  | "auto";

/** Output format. */
export type AIFormat = "vertical" | "horizontal" | "square";

/** The structured result from the AI intent router. */
export interface AIIntentResult {
  /** The classified action. */
  action: AIAction;
  /** 0..1 confidence in the classification. */
  confidence: number;
  /** Why the AI chose this interpretation. */
  reasoning: string;
  /** Typo-corrected version of the user's text. */
  normalizedText: string;

  // ---- Action-specific parameters (all optional) ----

  /** Time range for add_clip, extract, trim, etc. */
  timeRange?: AITimeRange;
  /** Source reference for source-specific actions. */
  sourceRef?: AISourceRef;
  /** Clip reference for clip-specific actions. */
  clipRef?: AIClipRef;
  /** Target clip for move_clip placement. */
  targetClipRef?: AIClipRef;
  /** Placement for move/add: "before" | "after" | "start" | "end". */
  placement?: "before" | "after" | "start" | "end";
  /** Duration in seconds (for create_highlight, trim_to_target). */
  durationSeconds?: number;
  /** Content topics the user is looking for. */
  topics?: string[];
  /** Concepts to exclude ("avoid the intro"). */
  excludeTopics?: string[];
  /** Output format. */
  format?: AIFormat;
  /** Transition type for set_transition. */
  transitionType?: AITransitionType;
  /** Boundary index for per-boundary transition. */
  transitionBoundary?: number;
  /** Whether to replace the current timeline or append. */
  replaceTimeline?: boolean;
  /** Answer text when answering a pending question. */
  answerText?: string;
  /** Chat reply for conversational turns. */
  chatReply?: string;
  /** Question to ask the user for clarification. */
  clarifyMessage?: string;
  /** Suggested quick replies for clarification. */
  suggestions?: string[];
  /** For multi-step commands (merge then trim). */
  sequence?: AIIntentResult[];
}

/** Compact editor state sent to the AI router (privacy-safe, text only). */
export interface AIRouterContext {
  uploadedVideoCount: number;
  selectedVideoCount: number;
  timelineClipCount: number;
  hasRenderedOutput: boolean;
  hasPendingAction: boolean;
  pendingActionKind?: string;
  hasPendingQuestion: boolean;
  pendingQuestionText?: string;
  pendingQuestionSuggestions?: string[];
  activeTargetSeconds?: number | null;
  activeSubject?: string | null;
  sourceNames?: string[];
  previousAssistantMessage?: string;
}

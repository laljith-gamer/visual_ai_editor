/**
 * Agentic edit-command model (Phase 1).
 *
 * This is the structured representation the agent resolves a natural
 * user turn into BEFORE it touches the timeline. It is intentionally a
 * separate file from the existing `lib/intent/types.ts` (which holds the
 * older `QuickMatch` shortcut envelope) so neither clobbers the other —
 * `QuickMatch` stays the fast high-precision gate; `EditCommand` is the
 * richer agentic layer that understands source/clip/range/concept/
 * placement references and append-vs-replace-vs-move-vs-remove intent.
 *
 * Design rules baked in here (from the project goal):
 *   - No hidden hardcoded clip-count / duration. Specs carry ONLY what
 *     the user actually said; the resolver fills the rest from context
 *     (single source → assume it, etc.) and records WHY in `assumptions`.
 *   - Unresolved-first: parsers emit `*Spec` shapes that name an intent
 *     ("first 2 min", "video 2") without needing the live duration / id.
 *     A separate resolve step turns specs into concrete seconds / ids so
 *     the parsing stays pure and unit-testable.
 *   - Exact ranges win: an `add_range` with an explicit time window must
 *     never be silently dropped by overlap/cap logic downstream.
 *
 * Everything here is pure types + the lightweight context the resolvers
 * read. No React, no store import — so the dev tester, unit tests, and a
 * future server reuse can all import it freely.
 */

// ---------------------------------------------------------------------
// Source / clip / time / placement reference specs
// ---------------------------------------------------------------------

/** How the user pointed at a SOURCE video. Unresolved — the resolver
 *  turns this into concrete source ids against the live library. */
export type SourceRef =
  | { kind: "index"; index: number; spoken: string }      // "video 2", "first video"
  | { kind: "active"; spoken: string }                    // "this video", "current"
  | { kind: "last_used"; spoken: string }                 // "that video", "the one I used"
  | { kind: "all"; spoken: string }                       // "all videos", "every clip"
  | { kind: "selected"; spoken: string }                  // "the selected videos"
  | { kind: "name_hint"; hint: string; spoken: string };  // fuzzy filename match

/** How the user pointed at a CLIP already on the timeline. */
export type ClipRef =
  | { kind: "index"; index: number; spoken: string }          // "clip 2"
  | { kind: "index_in_source"; index: number; sourceRef: SourceRef; spoken: string } // "clip 2 from video 1"
  | { kind: "first"; spoken: string }                         // "first clip"
  | { kind: "last"; spoken: string }                          // "last clip"
  | { kind: "selected"; spoken: string }                      // "this clip" / "the selected clip"
  | { kind: "last_created"; spoken: string }                  // "that clip" / "the one you just added"
  | { kind: "anaphora"; spoken: string };                     // "it" / "that" / "this" (resolve via memory)

/** Unresolved time-range intent. Resolved against a video duration (and
 *  optionally an anchor clip for relative phrasings). */
export type TimeRangeSpec =
  | { kind: "first_amount"; seconds: number; spoken: string }   // "first 2 min"
  | { kind: "last_amount"; seconds: number; spoken: string }    // "last 30 sec"
  | { kind: "middle_amount"; seconds: number; spoken: string }  // "middle 30 sec"
  | { kind: "first_half"; spoken: string }
  | { kind: "second_half"; spoken: string }
  | { kind: "middle_fraction"; spoken: string }                 // "the middle part"
  | { kind: "absolute"; startSeconds: number; endSeconds: number; spoken: string } // "1:20 to 2:10"
  | { kind: "before_time"; seconds: number; spoken: string }    // "before 1:00"
  | { kind: "after_time"; seconds: number; spoken: string }     // "after 2:00"
  | {
      // "10 seconds before clip 2", "5 seconds after that"
      kind: "relative_to_clip";
      anchor: ClipRef;
      direction: "before" | "after";
      seconds: number;
      spoken: string;
    };

/** Where a new / moved clip should land on the timeline. */
export type PlacementSpec =
  | { kind: "at_end"; spoken: string }
  | { kind: "at_start"; spoken: string }
  | { kind: "after_clip"; clipRef: ClipRef; spoken: string }
  | { kind: "before_clip"; clipRef: ClipRef; spoken: string }
  | { kind: "between_clips"; first: ClipRef; second: ClipRef; spoken: string };

/** A replacement / add target that is EITHER an explicit range or a
 *  semantic concept to search for. */
export type RangeOrConceptSpec =
  | { kind: "range"; sourceRef?: SourceRef; range: TimeRangeSpec }
  | { kind: "concept"; sourceRef?: SourceRef; concept: string };

// ---------------------------------------------------------------------
// The command union
// ---------------------------------------------------------------------

export type EditCommand =
  | { op: "add_range"; sourceRef?: SourceRef; range: TimeRangeSpec; placement?: PlacementSpec }
  | { op: "add_concept"; sourceRef?: SourceRef; concept: string; placement?: PlacementSpec }
  | { op: "add_clip_ref"; clipRef: ClipRef; placement?: PlacementSpec }
  | { op: "move_clip"; clipRef: ClipRef; placement: PlacementSpec }
  | { op: "remove_clip"; clipRef: ClipRef }
  | { op: "replace_clip"; target: ClipRef; replacement: RangeOrConceptSpec }
  | { op: "extend_clip"; clipRef: ClipRef; beforeSeconds?: number; afterSeconds?: number }
  | { op: "trim_clip"; clipRef: ClipRef; start?: number; end?: number }
  | { op: "reorder"; clipRef: ClipRef; placement: PlacementSpec }
  | { op: "render" };

export type EditCommandOp = EditCommand["op"];

// ---------------------------------------------------------------------
// Parser context + result
// ---------------------------------------------------------------------

/** Minimal, store-decoupled snapshot the resolvers + parser read. Mirrors
 *  the shape of `QuickMatchContext` but adds the bits the agentic layer
 *  needs (last-used source, last-created clips, transcript availability).
 *  Built once per turn from the live editor store by the client runner. */
export interface AgentCommandContext {
  sources: Array<{ id: string; name: string; duration: number }>;
  /** Currently active (preview) source id. */
  activeSourceId: string | null;
  /** Source the agent most recently created a clip from / acted on. */
  lastUsedSourceId: string | null;
  /** Source ids ticked for AI use. */
  selectedSourceIds: string[];
  /** Timeline clips in display order. */
  highlights: Array<{
    id: string;
    start: number;
    end: number;
    sourceId?: string;
    label?: string;
  }>;
  selectedClipId: string | null;
  /** Clip ids created by the most recent agent action (for "that clip"). */
  lastCreatedClipIds: string[];
  /** Source ids for which a local transcript is available (lets the
   *  parser know a concept search can be grounded in speech). */
  transcriptAvailableSourceIds: string[];
}

/** Result of parsing one user turn into a structured command. */
export interface ParsedCommandResult {
  /** The parsed command, or null when nothing matched (caller falls
   *  through to the existing quickMatch + cloud planner). */
  command: EditCommand | null;
  /** 0..1 — how confident the parse is. The orchestrator's confidence
   *  policy decides execute / assume / clarify from this combined with
   *  the resolver confidences. */
  confidence: number;
  /** Human-readable assumptions surfaced to the user ("Using video 2
   *  because it was the last edited source"). Never silent. */
  assumptions: string[];
  /** True when the command can't be resolved without asking the user. */
  needsClarification: boolean;
  /** Optional one-line clarify prompt when needsClarification is true. */
  clarification?: string;
  /** Quick-reply suggestions for the clarify prompt. */
  suggestions?: string[];
}

/** Empty / no-match result helper. */
export function noCommand(): ParsedCommandResult {
  return {
    command: null,
    confidence: 0,
    assumptions: [],
    needsClarification: false
  };
}

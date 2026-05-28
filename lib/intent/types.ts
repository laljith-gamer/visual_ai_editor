/**
 * v1.7.5 — Intent shortcutting types.
 *
 * The output of `quickMatch()` mirrors the AgentResponse modes the
 * cloud planner already produces, so the editor's existing dispatch
 * logic can route a shortcut-driven turn through the same code paths
 * it uses for cloud-planned turns.
 *
 * Boundary note (please preserve as future contributors land here):
 *   The system prompt's "no regex / keyword heuristics on user input"
 *   rule applies to the SERVER-SIDE planner. This module is CLIENT-
 *   SIDE intent shortcutting — a fast path that falls through to the
 *   untouched cloud planner on every miss. The cloud planner doesn't
 *   know this exists. Mismatch behaviour is benign.
 */

import type { EditOperation } from "@/lib/types";

export type QuickMatchKind =
  | "merge"
  | "extract"
  | "edit"
  | "promote"
  | "affirm"
  | "cancel";

export interface QuickMatchBase {
  kind: QuickMatchKind;
  /** 0..1 confidence; only matches >= the orchestrator threshold are returned. */
  confidence: number;
  /** Stable id for the rule that fired — used in activity logs and the
   *  dev tester. Format: `<intent>.<variant>` (e.g. `merge.basic`). */
  patternId: string;
  /** Original (trimmed) user text. Useful for the activity log. */
  matchedText: string;
}

export interface QuickMatchMerge extends QuickMatchBase {
  kind: "merge";
  /** Specific source ids the user named, in concatenation order.
   *  Undefined = use selectedSourceIds in library order. */
  sourceIds?: string[];
  transition: "none" | "fade" | "crossfade";
  op: "append" | "replace";
  /** v1.7.7 — optional per-source ranges. When provided, the merge
   *  dispatcher builds one highlight per entry using its (start, end)
   *  instead of the source's full duration. Drives the multi-clause
   *  trim path: "trim first 10 in first video, 5 in second video"
   *  produces two trimmed highlights, one per source. Order matches
   *  concatenation order on the timeline. */
  sourceRanges?: Array<{
    sourceId: string;
    startSeconds: number;
    endSeconds: number;
  }>;
}

export interface QuickMatchExtract extends QuickMatchBase {
  kind: "extract";
  range: {
    kind: "first" | "last" | "absolute";
    startSeconds: number;
    endSeconds: number;
    spoken?: string;
  };
  /** When the user named a specific source, the resolved id. */
  sourceId?: string;
}

export interface QuickMatchEdit extends QuickMatchBase {
  kind: "edit";
  /** Each operation matches the EditOperation shape used by the cloud
   *  edit-mode dispatcher in the editor page. */
  operations: EditOperation[];
}

export interface QuickMatchPromote extends QuickMatchBase {
  kind: "promote";
  /** When the user named specific best parts, the resolved ids. */
  partIds?: string[];
  /** Optional duration trim ("a 30s reel of these"). */
  targetSeconds?: number;
  op: "append" | "replace";
}

export interface QuickMatchAffirm extends QuickMatchBase {
  kind: "affirm";
}

export interface QuickMatchCancel extends QuickMatchBase {
  kind: "cancel";
}

export type QuickMatch =
  | QuickMatchMerge
  | QuickMatchExtract
  | QuickMatchEdit
  | QuickMatchPromote
  | QuickMatchAffirm
  | QuickMatchCancel;

/** Minimal store-shape the orchestrator + slot resolvers need. We don't
 *  import the full editor store directly — keeps the intent module
 *  pure and easy to test from any context (the dev tester page, unit
 *  tests, future server-side reuse). */
export interface QuickMatchContext {
  sources: Array<{
    id: string;
    meta: { name: string; duration: number };
  }>;
  selectedSourceIds: string[];
  highlights: Array<{
    id: string;
    start: number;
    end: number;
    sourceId?: string;
    label?: string;
  }>;
  selectedClipId: string | null;
  /** Last briefing in scope. Required for promote intent. */
  lastBriefing: {
    sourceId: string;
    bestParts: Array<{
      id: string;
      startSeconds: number;
      endSeconds: number;
      label: string;
    }>;
  } | null;
  /** Whether there's a plan-preview confirm waiting on user yes/no. */
  pendingExecution: boolean;
  /** Whether there's a clarify question waiting on a reply. */
  pendingClarify: boolean;
  /** Last assistant turn (used by affirm to verify there's something
   *  to affirm). */
  prevAssistantText?: string;
}

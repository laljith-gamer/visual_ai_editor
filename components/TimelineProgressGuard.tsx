"use client";

import { useEffect } from "react";
import { useEditorStore } from "@/hooks/useEditorStore";
import { logSystem } from "@/lib/log/recorders";
import type { Highlight } from "@/lib/types";

/**
 * TimelineProgressGuard
 *
 * Protects user curation from accidental replacement on AI-planned clip picks.
 *
 * Why this exists:
 * - Exact local shortcuts like "first 10 sec" / "last 30 sec" intentionally
 *   call setHighlights() directly and should keep their existing behavior.
 * - AI planner runs also end in setHighlights(), but that default replace path
 *   can wipe clips the user has already built up over multiple turns.
 * - This guard makes generated AI-pick highlights append-safe when a timeline
 *   already exists, while leaving explicit replace-like highlight sets alone.
 *
 * This is UI/editor state protection only. It does not change ffmpeg/rendering,
 * backend APIs, or the scoring pipeline.
 */
export function TimelineProgressGuard() {
  useEffect(() => {
    type StoreState = ReturnType<typeof useEditorStore.getState> & {
      __timelineProgressGuardInstalled?: boolean;
    };

    const current = useEditorStore.getState() as StoreState;
    if (current.__timelineProgressGuardInstalled) return;

    const originalSetHighlights = current.setHighlights;

    const guardedSetHighlights = (incoming: Highlight[]) => {
      const state = useEditorStore.getState();
      const existing = state.highlights;

      if (shouldPreserveTimeline(existing, incoming)) {
        const result = state.mergeHighlights(incoming);
        logSystem({
          sessionId: state.sessionId,
          kind: "timeline.progress_preserved",
          payload: {
            existing: existing.length,
            incoming: incoming.length,
            added: result.added,
            skipped: result.skipped
          },
          summary:
            result.added > 0
              ? `Preserved timeline progress; appended ${result.added} new clip${result.added === 1 ? "" : "s"}`
              : "Preserved timeline progress; no non-overlapping new clips to add"
        });
        return;
      }

      originalSetHighlights(incoming);
    };

    useEditorStore.setState({
      setHighlights: guardedSetHighlights,
      __timelineProgressGuardInstalled: true
    } as Partial<StoreState>);
  }, []);

  return null;
}

function shouldPreserveTimeline(
  existing: Highlight[],
  incoming: Highlight[]
): boolean {
  if (!Array.isArray(existing) || existing.length === 0) return false;
  if (!Array.isArray(incoming) || incoming.length === 0) return false;

  // Keep explicit user-directed replacement paths intact.
  // These are built by exact extract / merge / direct range helpers, not by
  // fuzzy AI clip-picking. The user already gave a concrete replacement action.
  if (incoming.every(isExplicitReplacementHighlight)) return false;

  // AI-picked highlights usually come from buildHighlights() / moment mode.
  // When the user already has a timeline, preserve progress and merge them.
  return true;
}

function isExplicitReplacementHighlight(h: Highlight): boolean {
  const reason = (h.reason ?? "").toLowerCase();

  return (
    reason.startsWith("extract ") ||
    reason.includes("full source merged as-is") ||
    reason.includes("trimmed and merged") ||
    reason.includes("range merged")
  );
}

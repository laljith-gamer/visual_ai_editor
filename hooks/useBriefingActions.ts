"use client";

// =====================================================================
// hooks/useBriefingActions.ts
//
// PHASE 5 (first extraction) — pull the structured briefing follow-up
// handler out of the very large app/editor/page.tsx into one focused,
// behavior-identical hook.
//
// Briefing chips carry intent (promote / plan_topic / extract_range)
// instead of plain text, so each runs a DETERMINISTIC path here with NO
// cloud planner round-trip. This is what eliminates the "what should the
// short be about?" clarify loop after a briefing: the app no longer asks
// the LLM to re-interpret a sentence it already turned into a button.
//
// `chat` follow-ups never reach this hook — AssistantPanel routes them
// through the normal chat pipe (onSubmit) so typed chat and chip-chat
// behave identically.
//
// All three branches are synchronous store ops / pure builders (the same
// code the cloud promote/extract/plan handlers use), so no busy toggle or
// network call is involved.
//
// This hook owns NO state of its own; it reuses the existing store actions
// and pure builders, taking the editor's setters/loggers as params so the
// page stays the single owner of React state. Behavior is identical to the
// previous inline `handleBriefingAction`, with one additive fix: a
// `plan_topic` action now locks the generated plan to its briefing's
// `sourceId` (see PLAN_TOPIC branch) so multi-source projects stay
// grounded on the source that was actually briefed.
// =====================================================================

import { useCallback } from "react";
import { useEditorStore } from "@/hooks/useEditorStore";
import { buildExtractedHighlight } from "@/lib/pipeline/extract";
import { normalizePlan } from "@/lib/plan/normalize";
import { SIGNAL_DEFAULTS } from "@/lib/config";
import type { BriefingFollowUp } from "@/lib/types";

/** Store type derived from the live store so param types never drift from
 *  the actual action signatures (EditorState is not exported). */
type EditorStore = ReturnType<typeof useEditorStore.getState>;

/** The subset of the editor's `logSession` helper this hook uses. Matches
 *  the structural shape created in app/editor/page.tsx. */
interface BriefingActionLogger {
  ai: (
    kind: string,
    payload: Record<string, unknown>,
    summary?: string,
    ms?: number
  ) => void;
  user: (
    kind: string,
    payload: Record<string, unknown>,
    summary?: string
  ) => void;
}

export interface UseBriefingActionsParams {
  busy: boolean;
  videoBlob: EditorStore["videoBlob"];
  videoHash: EditorStore["videoHash"];
  videoMeta: EditorStore["videoMeta"];
  pushMessage: EditorStore["pushMessage"];
  setStatus: EditorStore["setStatus"];
  setProgress: EditorStore["setProgress"];
  setHighlights: EditorStore["setHighlights"];
  setPlan: EditorStore["setPlan"];
  setMode: EditorStore["setMode"];
  setInferred: EditorStore["setInferred"];
  setPendingClarify: EditorStore["setPendingClarify"];
  setPendingExecution: EditorStore["setPendingExecution"];
  logSession: BriefingActionLogger;
  /** The normal chat pipe — used only as a safety fallback for a
   *  pathological (empty-prompt) plan_topic action. */
  handleAgent: (text: string) => Promise<void>;
}

/**
 * Returns a stable `handleBriefingAction(action)` callback that executes a
 * structured briefing follow-up deterministically.
 */
export function useBriefingActions(params: UseBriefingActionsParams) {
  const {
    busy,
    videoBlob,
    videoHash,
    videoMeta,
    pushMessage,
    setStatus,
    setProgress,
    setHighlights,
    setPlan,
    setMode,
    setInferred,
    setPendingClarify,
    setPendingExecution,
    logSession,
    handleAgent
  } = params;

  return useCallback(
    (action: BriefingFollowUp) => {
      if (busy) return;

      // ---- PROMOTE — lift the briefing's best parts onto the timeline ---
      if (action.kind === "promote") {
        const briefing = useEditorStore.getState().lastBriefing;
        if (!briefing || briefing.bestParts.length === 0) {
          pushMessage({
            role: "assistant",
            content:
              "I don't have a recent briefing in scope to clip from. Ask me to describe the video first."
          });
          return;
        }
        logSession.user(
          "briefing.followup",
          { kind: "promote", label: action.label, op: action.op ?? "append" },
          `Briefing action: ${action.label}`
        );
        const result = useEditorStore.getState().promoteBriefingParts({
          partIds: action.partIds,
          targetSeconds: action.targetSeconds,
          op: action.op ?? "append"
        });
        if (result.added === 0 && result.total === 0) {
          pushMessage({
            role: "assistant",
            content:
              "Couldn't promote any briefing parts \u2014 they may not match the requested ids."
          });
          return;
        }
        // Switch active source so the preview lines up with the new clips.
        if (
          briefing.sourceId &&
          briefing.sourceId !== useEditorStore.getState().activeSourceId &&
          useEditorStore.getState().sources.some((s) => s.id === briefing.sourceId)
        ) {
          useEditorStore.getState().setActiveSource(briefing.sourceId);
        }
        const finalTimeline = useEditorStore.getState().highlights;
        const total = finalTimeline.reduce((a, h) => a + (h.end - h.start), 0);
        const skippedNote =
          result.skipped > 0
            ? ` (${result.skipped} skipped \u2014 overlap with existing clips)`
            : "";
        const opVerb = action.op === "replace" ? "Replaced with" : "Added";
        pushMessage({
          role: "assistant",
          content: `${opVerb} ${result.added} clip${result.added === 1 ? "" : "s"} from the briefing${skippedNote}. Timeline is now ${finalTimeline.length} clip${finalTimeline.length === 1 ? "" : "s"}, ${total.toFixed(1)}s total.`
        });
        setStatus("ready", undefined);
        setProgress(1);
        logSession.ai(
          "promote.applied",
          {
            source: "briefing-chip",
            added: result.added,
            skipped: result.skipped,
            total: result.total,
            op: action.op ?? "append"
          },
          `Promoted ${result.added} briefing parts to the timeline`
        );
        return;
      }

      // ---- EXTRACT_RANGE — deterministic exact slice --------------------
      if (action.kind === "extract_range") {
        const store = useEditorStore.getState();
        const sid = action.sourceId || store.activeSourceId || undefined;
        const src = store.sources.find((s) => s.id === sid) ?? store.sources[0];
        if (!src) {
          pushMessage({
            role: "assistant",
            content: "Upload a video first, then I can grab that slice."
          });
          return;
        }
        logSession.user(
          "briefing.followup",
          {
            kind: "extract_range",
            label: action.label,
            startSeconds: action.startSeconds,
            endSeconds: action.endSeconds
          },
          `Briefing action: ${action.label}`
        );
        const built = buildExtractedHighlight({
          range: {
            kind: "absolute",
            startSeconds: action.startSeconds,
            endSeconds: action.endSeconds
          },
          videoDuration: src.meta.duration,
          transition: "none"
        });
        if (built.length === 0) {
          pushMessage({
            role: "assistant",
            content:
              "That range doesn't fit inside this video \u2014 try a different moment."
          });
          return;
        }
        const tagged = built.map((h) => ({ ...h, sourceId: h.sourceId ?? src.id }));
        if (store.highlights.length > 0) {
          useEditorStore.getState().mergeHighlights(tagged, { allowOverlap: true });
        } else {
          setHighlights(tagged);
        }
        if (src.id !== useEditorStore.getState().activeSourceId) {
          useEditorStore.getState().setActiveSource(src.id);
        }
        const finalCount = useEditorStore.getState().highlights.length;
        pushMessage({
          role: "assistant",
          content: `Added that slice \u2014 ${finalCount} clip${finalCount === 1 ? "" : "s"} on the timeline now.`
        });
        setStatus("ready", "Ready to render");
        setProgress(1);
        logSession.ai(
          "extract.applied",
          {
            source: "briefing-chip",
            start: built[0].start,
            end: built[0].end,
            durationSec: built[0].end - built[0].start
          },
          `Extracted ${action.startSeconds.toFixed(1)}s \u2192 ${action.endSeconds.toFixed(1)}s verbatim`
        );
        return;
      }

      // ---- PLAN_TOPIC — build an EditPlan + pending execution -----------
      // We construct the plan client-side via the SAME normalizer the cloud
      // planner output flows through, then park it as a pending execution.
      // No /api/agent call, so the server never re-guesses the topic and we
      // never fall into clarify.
      //
      // v1.8.2 — Lock the plan to the briefing's source. In a multi-source
      // project a briefing is about ONE video; without this the generated
      // plan could run across every selected source. `normalizePlan`
      // sanitizes `sources` (string[], capped), so passing the briefing's
      // sourceId keeps the run grounded on the source that was briefed.
      if (action.kind === "plan_topic") {
        const { plan } = normalizePlan({
          scenarios: [{ id: "topic", prompt: action.scenarioPrompt }],
          signals: action.signals ?? SIGNAL_DEFAULTS.scenarioHeavy,
          userSpecifiedDuration: false,
          sources: action.sourceId ? [action.sourceId] : undefined
        });
        if (!plan) {
          // Pathological (empty prompt) — fall back to the chat pipe rather
          // than doing nothing. handleAgent owns its own busy lifecycle.
          void handleAgent(action.topic);
          return;
        }
        logSession.user(
          "briefing.followup",
          { kind: "plan_topic", label: action.label, topic: action.topic },
          `Briefing action: ${action.label}`
        );
        setPlan(plan);
        setMode("plan");
        setInferred([]);
        setPendingClarify(null);
        pushMessage({
          role: "assistant",
          content: `On it \u2014 ${action.topic.slice(0, 80)}.`
        });
        const hasVideo = !!(videoBlob && videoHash && videoMeta);
        if (!hasVideo) {
          setStatus("idle", "Plan ready \u2014 upload a video to run the analysis.");
          setProgress(0);
          setPendingExecution(true);
        } else {
          const hasClips = useEditorStore.getState().highlights.length > 0;
          useEditorStore
            .getState()
            .setPendingTimelineOp(hasClips ? "append" : "replace");
          setPendingExecution(true);
          setStatus("ready", "Plan ready \u2014 tap Run analysis to start.");
          setProgress(0);
        }
        logSession.ai(
          "plan.created",
          {
            source: "briefing-chip",
            topic: action.topic,
            scenarios: [action.scenarioPrompt],
            sources: action.sourceId ? [action.sourceId] : undefined
          },
          `Plan from briefing chip: ${action.topic.slice(0, 60)}`
        );
        return;
      }
    },
    [
      busy,
      videoBlob,
      videoHash,
      videoMeta,
      pushMessage,
      setStatus,
      setProgress,
      setHighlights,
      setPlan,
      setMode,
      setInferred,
      setPendingClarify,
      setPendingExecution,
      logSession,
      handleAgent
    ]
  );
}

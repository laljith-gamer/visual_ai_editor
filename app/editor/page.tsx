"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Topbar } from "@/components/Topbar";
import { ProjectRail } from "@/components/ProjectRail";
import { EditorStage } from "@/components/EditorStage";
import { AssistantPanel } from "@/components/AssistantPanel";
import { ClipsDrawer } from "@/components/ClipsDrawer";
import { ActivityDrawer } from "@/components/ActivityDrawer";
import { TranscriptDrawer } from "@/components/TranscriptDrawer";
import { QuotaBanner } from "@/components/QuotaBanner";
import { useEditorStore, scenariosChanged } from "@/hooks/useEditorStore";
import { useFFmpeg } from "@/hooks/useFFmpeg";
import { useCapability } from "@/hooks/useCapability";
import { useActivityLog } from "@/hooks/useActivityLog";
import { useExport } from "@/hooks/useExport";
import { sampleFrames } from "@/lib/pipeline/sample";
import { scoreFrames } from "@/lib/pipeline/score";
import { detectCandidateWindows } from "@/lib/pipeline/events";
import { runTemporalPass } from "@/lib/pipeline/temporal";
import { buildHighlights } from "@/lib/pipeline/highlights";
import { buildMomentHighlight } from "@/lib/pipeline/moment";
import { buildExtractedHighlight } from "@/lib/pipeline/extract";
import {
  executeForSource,
  mergeAcrossSources
} from "@/lib/pipeline/executePerSource";
import { assessTargetCoverage } from "@/lib/pipeline/coverage";
import { VIDEO_PROMPT } from "@/lib/config";
import { buildComposeSubPlan, buildComposeOutputPlan } from "@/lib/plan/composeSubPlan";
import {
  resolveComposeSources,
  type ResolvableSource
} from "@/lib/plan/composeResolve";
import { orderComposedClips, makeRng } from "@/lib/plan/composeOrder";
import {
  resolveComposeTransition,
  type RenderTransition
} from "@/lib/plan/composeTransition";
import { planSignaturePayload } from "@/lib/plan/normalize";
import {
  getPredictions,
  savePredictions,
  trimCache
} from "@/lib/store/cache";
import { friendlyStorageError } from "@/lib/store/idb";
import { projectPersistSignature } from "@/lib/store/projectSignature";
import { sha1String } from "@/lib/util/hash";
import { logAi, logSystem, logUser } from "@/lib/log/recorders";
import { summarizeRecentActivity } from "@/lib/log/summarize";
import { useBriefingActions } from "@/hooks/useBriefingActions";
import { LOCAL_LLM } from "@/lib/local-llm/config";
import type {
  AgentRequest,
  AgentResponse,
  ComposeRole,
  ComposeSourceSelection,
  ComposeTransitionType,
  EditPlan,
  FrameScore,
  Highlight,
  InferredField,
  IntentMode,
  VideoLibraryEntry
} from "@/lib/types";

interface QuotaWarning {
  usage: number;
  limit: number;
  fraction: number;
}

/**
 * Result of the optional second-tier LOCAL WebLLM planner recovery
 * (cloud → local → manual). "planned" carries a synthesized plan-mode
 * response to continue with; "handled" means the local path already
 * messaged the user (e.g. a vision ask it can't satisfy); "none" means
 * fall back to surfacing the original cloud error.
 */
type LocalRecovery =
  | { outcome: "planned"; response: Exclude<AgentResponse, { mode: "error" }> }
  | { outcome: "handled" }
  | { outcome: "none" };

export default function Home() {
  const [clipsDrawerOpen, setClipsDrawerOpen] = useState(false);
  const [activityDrawerOpen, setActivityDrawerOpen] = useState(false);
  const [transcriptDrawerOpen, setTranscriptDrawerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [quota, setQuota] = useState<QuotaWarning | null>(null);
  const [unreadActivity, setUnreadActivity] = useState(0);
  const ffmpeg = useFFmpeg();
  const cap = useCapability();

  const sessionId = useEditorStore((s) => s.sessionId);
  const events = useActivityLog(sessionId);

  const videoBlob = useEditorStore((s) => s.videoBlob);
  const videoMeta = useEditorStore((s) => s.videoMeta);
  const videoHash = useEditorStore((s) => s.videoHash);
  const memory = useEditorStore((s) => s.memory);
  const plan = useEditorStore((s) => s.plan);
  const highlights = useEditorStore((s) => s.highlights);
  const recomputeAutoTransitions = useEditorStore((s) => s.recomputeAutoTransitions);

  // PR 59 — recompute auto transitions whenever the clip SEQUENCE changes
  // (add / move / remove / replace / source change), but NOT on every
  // resize/position tweak. Manual overrides are preserved by the store.
  // Deterministic + offline; no WebGPU/cloud.
  const timelineSeqKey = useMemo(
    () => highlights.map((h) => `${h.id}:${h.sourceId ?? ""}`).join("|"),
    [highlights]
  );
  useEffect(() => {
    recomputeAutoTransitions();
  }, [timelineSeqKey, recomputeAutoTransitions]);

  const pushMessage = useEditorStore((s) => s.pushMessage);
  const setStatus = useEditorStore((s) => s.setStatus);
  const setProgress = useEditorStore((s) => s.setProgress);
  const setPlan = useEditorStore((s) => s.setPlan);
  const applyPlanPatch = useEditorStore((s) => s.applyPlanPatch);
  const setHighlights = useEditorStore((s) => s.setHighlights);
  const setRendered = useEditorStore((s) => s.setRendered);
  const setMode = useEditorStore((s) => s.setMode);
  const setInferred = useEditorStore((s) => s.setInferred);
  const setPendingClarify = useEditorStore((s) => s.setPendingClarify);
  const setPendingExecution = useEditorStore((s) => s.setPendingExecution);
  const setUserTier = useEditorStore((s) => s.setUserTier);
  const persist = useEditorStore((s) => s.persist);

  // ---- Track unread activity events while the drawer is closed ------------
  const lastSeenEventCountRef = useRef(events.length);
  useEffect(() => {
    if (activityDrawerOpen) {
      lastSeenEventCountRef.current = events.length;
      setUnreadActivity(0);
    } else {
      const newOnes = events.length - lastSeenEventCountRef.current;
      if (newOnes > 0) setUnreadActivity(newOnes);
    }
  }, [events.length, activityDrawerOpen]);

  // Persist whenever any DURABLE project state changes — not just chat /
  // plan / highlight COUNT. The signature (a pure, cheap string) covers
  // sources, missing placeholders, active/selected source, selected clip,
  // boundary transitions, pending op/exec, mode, inferred chips, tier, last
  // briefing, memory, status, etc. `progress` is intentionally excluded so a
  // running pipeline's per-frame ticks don't spam IndexedDB. A debounce
  // coalesces rapid edits into one write.
  const persistSignature = useEditorStore((s) => projectPersistSignature(s));
  useEffect(() => {
    const t = setTimeout(() => {
      void persist();
    }, 500);
    return () => clearTimeout(t);
  }, [persistSignature, persist]);

  // ---- Helper: log AI / system / user events with the active sessionId ---
  const logSession = useMemo(
    () => ({
      ai: (kind: string, payload: Record<string, unknown>, summary?: string, ms?: number) =>
        logAi({ sessionId, kind, payload, summary, ms }),
      system: (kind: string, payload: Record<string, unknown>, summary?: string) =>
        logSystem({ sessionId, kind, payload, summary }),
      user: (kind: string, payload: Record<string, unknown>, summary?: string) =>
        logUser({ sessionId, kind, payload, summary })
    }),
    [sessionId]
  );

  // ---- v1.7.5 — Forward ref so handleAgent's quick-shortcut gate can
  // dispatch the existing handleRunPipeline without ordering grief.
  // (handleRunPipeline is defined further down, but the gate needs it
  // when an "affirm" shortcut fires.)
  const handleRunPipelineRef = useRef<(() => Promise<void>) | null>(null);
  // Same forward-reference pattern for render, so the agentic fast-command
  // path can trigger the real render without reordering the component.
  const handleRenderRef = useRef<(() => void) | null>(null);
  // Export/download of the rendered short (chat "export" command reuses
  // the same path as the Export button).
  const exportShort = useExport();
  const handleExportRef = useRef<(() => Promise<{ ok: boolean; message: string }>) | null>(null);
  useEffect(() => {
    handleExportRef.current = exportShort;
  }, [exportShort]);
  //
  // 1. Resolve which library sources are eligible for THIS run:
  //    intersect (selectedSourceIds) ∩ (plan.sources OR all-eligible).
  // 2. If only one source is eligible, run executeForSource once and
  //    set its highlights directly. Same UX as v1.5.x.
  // 3. If multiple sources are eligible, loop sequentially — each call
  //    runs sample → score → temporal → buildHighlights for its source
  //    and returns a tagged highlights[] without touching the store.
  //    We accumulate, merge globally via mergeAcrossSources (time-fused
  //    + budget-capped), then setHighlights once at the end so the user
  //    never sees mid-loop flicker.
  //
  // The orchestrator owns: status messages, progress bar, top-level
  // chat replies. The executor owns: caching, sampling, scoring,
  // selection. This split is intentional — multi-source policy can
  // evolve here without changing the per-source steps.
  // -----------------------------------------------------------------------
  const runPipeline = useCallback(
    async (
      mode: IntentMode,
      opts?: {
        /** v1.7.1 — when set, the pipeline runs ONLY against this
         *  subset of scenarios and APPENDS the resulting highlights
         *  to whatever is already on the timeline (via the store's
         *  mergeHighlights action). Used by append-style refinements
         *  ("add the celebration too") so previously-curated clips
         *  are preserved across the run. The values are scenario ids
         *  drawn from the active plan's scenarios array. */
        appendScenarioIds?: string[];
      }
    ) => {
      const state = useEditorStore.getState();
      const fullPlan = state.plan;
      if (!fullPlan) return;
      if (mode !== "plan" && mode !== "moment") return;

      // v1.7.1 — append-mode subset plan. We don't mutate the active
      // plan stored in zustand — that one is already the merged
      // (existing + new scenarios) result. The pipeline just runs
      // against a transient *subset* so it doesn't re-score
      // previously-evaluated scenarios.
      // v1.7.9 — Two distinct flags:
      //   subsetAppend     — the caller passed scenario ids to re-score
      //                      a SUBSET (the "add the celebration too"
      //                      refinement). Guards the subset-plan block
      //                      below. Must read opts safely because a
      //                      deferred "Run analysis" tap calls us with
      //                      no opts at all.
      //   appendToTimeline — whether the FINAL results should be folded
      //                      into the existing timeline (merge) rather
      //                      than replacing it. True when this is a
      //                      subset append OR the editor parked an
      //                      "append" decision in pendingTimelineOp,
      //                      AND there's actually something to append to.
      const subsetAppend =
        Array.isArray(opts?.appendScenarioIds) &&
        (opts?.appendScenarioIds?.length ?? 0) > 0;
      const existingClipCount = state.highlights.length;
      const appendToTimeline =
        existingClipCount > 0 &&
        (subsetAppend ||
          useEditorStore.getState().pendingTimelineOp === "append");
      let activePlan = fullPlan;
      if (subsetAppend) {
        const wanted = new Set(opts!.appendScenarioIds);
        const subsetScenarios = fullPlan.scenarios.filter((s) => wanted.has(s.id));
        if (subsetScenarios.length === 0) {
          // Defensive — the planner asked us to append but no matching
          // ids landed in the merged plan. Fall back to a full run.
          // (This path is rare but we'd rather over-score than skip
          //  the user's new ask entirely.)
        } else {
          // Re-balance label weights inside the subset so they sum to 1
          // (the scorer expects normalised weights). Outside the subset
          // we don't care — those scenarios aren't being scored.
          const subsetWeights: Record<string, number> = {};
          let total = 0;
          for (const s of subsetScenarios) {
            const w = fullPlan.labelWeights[s.id] ?? s.weight ?? 1;
            subsetWeights[s.id] = w;
            total += w;
          }
          if (total > 0) {
            for (const k of Object.keys(subsetWeights)) {
              subsetWeights[k] = subsetWeights[k] / total;
            }
          }
          activePlan = {
            ...fullPlan,
            scenarios: subsetScenarios,
            labelWeights: subsetWeights
          };
        }
      }

      // Resolve eligible sources.
      const allSources = state.sources;
      const selected = new Set(state.selectedSourceIds);
      const planFilter = activePlan.sources && activePlan.sources.length > 0
        ? new Set(activePlan.sources)
        : null;
      const eligible = allSources.filter(
        (s) => selected.has(s.id) && (!planFilter || planFilter.has(s.id))
      );

      if (eligible.length === 0) {
        pushMessage({
          role: "assistant",
          content: allSources.length === 0
            ? "Upload a video to the library first, then I can pick the best parts."
            : "No videos selected for AI use \u2014 tick at least one in the library."
        });
        setStatus("idle", "No source selected");
        setProgress(0);
        setPendingExecution(false);
        return;
      }

      const userTier = state.userTier;
      const t0 = Date.now();

      try {
        const perSource: Array<{
          sourceName: string;
          sourceId: string;
          weakOnly: boolean;
          scoreMax: number;
          highlights: ReturnType<typeof Array.from> | unknown;
          count: number;
        }> = [];
        const aggregate = [] as Awaited<
          ReturnType<typeof executeForSource>
        >[];

        for (let i = 0; i < eligible.length; i++) {
          const src = eligible[i];
          const baseProgress = i / eligible.length;
          const slot = 1 / eligible.length;
          const result = await executeForSource({
            source: src,
            plan: activePlan,
            mode,
            capTier: cap.tier,
            userTier,
            log: logSession,
            progress: {
              setStatus: (s, detail) =>
                setStatus(
                  s as Parameters<typeof setStatus>[0],
                  eligible.length > 1
                    ? `${detail ?? s} (${i + 1}/${eligible.length})`
                    : detail
                ),
              setProgress: (p) =>
                setProgress(Math.min(1, baseProgress + p * slot))
            }
          });
          aggregate.push(result);
          perSource.push({
            sourceName: src.meta.name,
            sourceId: src.id,
            weakOnly: result.weakOnly,
            scoreMax: result.scoreMax,
            highlights: undefined,
            count: result.highlights.length
          });
        }

        // Merge + cap to plan budget. mergeAcrossSources also handles
        // moment-mode ("pick the single winner across sources").
        const merged = mergeAcrossSources(aggregate, activePlan, mode);

        if (merged.highlights.length === 0) {
          // v1.7.1 — append runs are softer about empty results. The
          // user already has clips on the timeline; we don't want to
          // shout "nothing matched" and erase the success of the
          // earlier turn. Just log it and move on.
          if (appendToTimeline) {
            pushMessage({
              role: "assistant",
              content:
                eligible.length === 1
                  ? `Couldn't find anything new for "${activePlan.scenarios[0]?.prompt ?? "that"}" \u2014 your earlier clips are still on the timeline.`
                  : "Couldn't find new matches across the selected videos. Your earlier clips are still on the timeline."
            });
            setStatus("ready", "No new matches");
            setProgress(0);
            return;
          }
          const msg =
            mode === "moment"
              ? "I couldn't lock onto that moment in any selected video. Try describing what would be on screen \u2014 colours, action, who's doing what."
              : `Nothing across the selected video${eligible.length === 1 ? "" : "s"} matched strongly enough (top score ${merged.scoreMax.toFixed(2)}). Try broader scenarios, or describe a single moment ("find the part where ___").`;
          pushMessage({ role: "assistant", content: msg });
          setStatus("ready", "No strong matches");
          setProgress(0);
          return;
        }

        // v1.7.9 — append vs replace. On append we preserve every
        // existing clip and only fold in the new ones; on a fresh run
        // we replace the whole timeline as before. The append decision
        // now also covers fresh full-plan runs (a new topic on top of
        // an existing reel), not just subset refinements.
        if (appendToTimeline) {
          const { added, skipped } = useEditorStore
            .getState()
            .mergeHighlights(merged.highlights);
          if (added === 0) {
            pushMessage({
              role: "assistant",
              content:
                "Found new matches but they overlap clips you already have \u2014 nothing to add."
            });
            setStatus("ready", undefined);
            setProgress(0);
            return;
          }
          // Continue below to the "summary" message + soft notice.
          // The variables `total` and `summary` will reflect the
          // FULL timeline (existing + appended), which is what we
          // want the user to see.
          void skipped; // logged below
        } else {
          setHighlights(merged.highlights);
        }

        // Pick the active source to whatever the first kept clip points
        // at, so the preview pane plays the right footage immediately.
        const firstSourceId = merged.highlights[0]?.sourceId;
        if (firstSourceId && firstSourceId !== state.activeSourceId) {
          useEditorStore.getState().setActiveSource(firstSourceId);
        }

        // v1.7.1 — On append the canonical post-run state lives in the
        // store (mergeHighlights preserved + extended it). For fresh
        // runs the store reflects `merged.highlights` exactly. Either
        // way, read from the store so the summary mentions the FULL
        // timeline length the user is looking at.
        const finalTimeline = useEditorStore.getState().highlights;
        const total = finalTimeline.reduce(
          (acc, h) => acc + (h.end - h.start),
          0
        );
        const newClipCount = appendToTimeline
          ? merged.highlights.length
          : finalTimeline.length;

        // Issue #62 — target-coverage guard. When the user asked for an
        // explicit duration but the result falls materially short (a hard
        // underfill, or a weak-confidence underfill), we must NOT silently
        // mark it "ready to render" / push "Tap Render". Surface an honest
        // message and offer the broader fallback instead. Skipped for append
        // and single-moment runs (they aren't duration-fill requests).
        if (!appendToTimeline && mode !== "moment") {
          const coverage = assessTargetCoverage({
            userSpecifiedDuration: activePlan.userSpecifiedDuration === true,
            targetSeconds: activePlan.targetShortSeconds,
            selectedSeconds: total,
            clipCount: finalTimeline.length,
            weakOnly: merged.weakOnly,
            scoreMax: merged.scoreMax
          });
          if (coverage.level === "review") {
            pushMessage({
              role: "assistant",
              content: coverage.message ?? ""
            });
            setStatus("needs_review", coverage.statusDetail);
            setProgress(1);
            logSession.ai(
              "highlights.underfilled",
              {
                target: activePlan.targetShortSeconds,
                selectedSeconds: round1(total),
                clips: finalTimeline.length,
                ratio: round1(coverage.ratio),
                weakOnly: merged.weakOnly,
                scoreMax: round1(merged.scoreMax)
              },
              `Underfilled: ${round1(total)}s of ${activePlan.targetShortSeconds}s`,
              Date.now() - t0
            );
            return;
          }
        }

        // Build a friendly summary that mentions the source breakdown
        // when the run was multi-source.
        let summary: string;
        if (appendToTimeline) {
          summary =
            eligible.length === 1
              ? `Added ${newClipCount} new clip${newClipCount === 1 ? "" : "s"} from "${eligible[0].meta.name}". Timeline is now ${finalTimeline.length} clip${finalTimeline.length === 1 ? "" : "s"}, ${total.toFixed(1)}s total.`
              : `Added ${newClipCount} new clip${newClipCount === 1 ? "" : "s"}. Timeline is now ${finalTimeline.length} clip${finalTimeline.length === 1 ? "" : "s"}, ${total.toFixed(1)}s total.`;
        } else if (eligible.length === 1) {
          summary =
            mode === "moment"
              ? `Found it. Picked a ${(merged.highlights[0].end - merged.highlights[0].start).toFixed(1)}s clip from "${eligible[0].meta.name}".`
              : `Picked ${merged.highlights.length} clip${merged.highlights.length === 1 ? "" : "s"} totalling ${total.toFixed(1)}s from "${eligible[0].meta.name}". Tap "Render" to assemble.`;
        } else {
          const breakdown = perSource
            .filter((s) => s.count > 0)
            .map((s) => `"${s.sourceName}" (${s.count})`)
            .join(", ");
          summary =
            mode === "moment"
              ? `Found the moment in "${eligible.find((e) => e.id === merged.highlights[0].sourceId)?.meta.name ?? "library"}".`
              : `Picked ${merged.highlights.length} clip${merged.highlights.length === 1 ? "" : "s"} (${total.toFixed(1)}s) from ${breakdown}. Tap "Render".`;
        }
        if (merged.weakOnly) {
          summary +=
            ` Heads up \u2014 match confidence is on the low side (top score ${merged.scoreMax.toFixed(2)}).`;
          // v1.7.2 — when there's a recent briefing in scope, point the
          // user at the cheaper / better path. The briefing already
          // identified strong moments; promote-mode lifts them onto
          // the timeline without another vision call.
          const lastBriefing = useEditorStore.getState().lastBriefing;
          if (
            lastBriefing &&
            lastBriefing.bestParts.length > 0 &&
            lastBriefing.sourceId === firstSourceId
          ) {
            summary +=
              ` Want me to use the ${lastBriefing.bestParts.length} moments I identified earlier instead? Say "use the briefing".`;
          }
        }
        pushMessage({ role: "assistant", content: summary });

        // v1.7.1 — Soft over-budget notice. When the user has set an
        // explicit duration AND the timeline is now materially over
        // it, surface a one-line nudge in chat. We do NOT auto-trim —
        // the user has agency. The "trim to fit" copy maps directly
        // to a planner refinement turn that re-runs selection over
        // the cached scores with the existing budget.
        const overBudget =
          activePlan.userSpecifiedDuration === true &&
          activePlan.targetShortSeconds > 0 &&
          total > activePlan.targetShortSeconds * 1.1;
        if (overBudget) {
          pushMessage({
            role: "assistant",
            content: `You're at ${total.toFixed(1)}s, target was ${activePlan.targetShortSeconds}s. Say "trim to fit" if you want me to enforce it.`
          });
        }

        logSession.ai(
          "highlights.merged",
          {
            mode,
            sourceCount: eligible.length,
            keptClips: merged.highlights.length,
            totalSeconds: round1(total),
            weakOnly: merged.weakOnly,
            strategy: activePlan.selectionStrategy,
            perSource: perSource.map((s) => ({
              sourceId: s.sourceId,
              count: s.count,
              weakOnly: s.weakOnly,
              scoreMax: round1(s.scoreMax)
            }))
          },
          eligible.length === 1
            ? `Picked ${merged.highlights.length} clip${merged.highlights.length === 1 ? "" : "s"}`
            : `Merged ${merged.highlights.length} clip${merged.highlights.length === 1 ? "" : "s"} from ${eligible.length} sources`,
          Date.now() - t0
        );

        setStatus("ready", "Ready to render");
        setProgress(1);
      } catch (err) {
        const msg = friendlyStorageError(err) ?? (err as Error).message;
        pushMessage({
          role: "assistant",
          content: `Something went wrong: ${msg}`
        });
        setStatus("failed", msg);
        logSession.system(
          "error.unhandled",
          { phase: "pipeline", message: msg },
          `Unhandled error: ${msg.slice(0, 80)}`
        );
      } finally {
        setPendingExecution(false);
      }
    },
    [
      cap.tier,
      pushMessage,
      setStatus,
      setProgress,
      setHighlights,
      setPendingExecution,
      logSession
    ]
  );

  // ---- Submit a chat turn -------------------------------------------------
  const handleAgent = useCallback(
    async (userRequest: string) => {
      setBusy(true);
      pushMessage({ role: "user", content: userRequest });
      const previousPlan = useEditorStore.getState().plan;

      // v2.1 — Agentic intake may compile a clean, structured brief for this
      // turn. When it does, the local-planner fallback (below) plans from the
      // compiled prompt instead of the raw messy text. Stays undefined for
      // passthrough turns so behaviour is unchanged there.
      let intakeCompiledPrompt: string | undefined;

      // ---- Agentic command layer (deterministic-first) ---------------
      // Resolve natural editing commands (source/clip/range/concept/
      // placement references, append-vs-replace-vs-move-vs-remove,
      // reinforcement) into structured timeline operations BEFORE the
      // older quick-shortcut gate and the cloud planner. It is additive
      // and reversible: `handled === false` falls straight through to the
      // unchanged paths below; `needsVisual` means the concept needs the
      // frame pipeline, so we also fall through to the cloud planner that
      // builds scenarios + runs it. Lazy-imported so its weight stays out
      // of the initial /editor bundle.
      try {
        const { tryAgentCommand } = await import("@/lib/agent/runAgentCommand");
        const outcome = await tryAgentCommand(userRequest, {
          pushMessage,
          setStatus,
          setProgress,
          sessionId,
          logSession,
          onRender: () => void handleRenderRef.current?.(),
          onExport: () =>
            handleExportRef.current
              ? handleExportRef.current()
              : Promise.resolve({ ok: false, message: "Export isn't ready yet." })
        });
        if (outcome.handled) {
          setBusy(false);
          return;
        }
        // needsVisual / fallthrough → continue to the existing paths.
      } catch (err) {
        logSession.system(
          "agent.command.path.failed",
          { message: (err as Error).message, userRequest },
          `Agent command path errored, falling back: ${(err as Error).message.slice(0, 80)}`
        );
      }

      // ---- v2.1 — Agentic intake layer (universal vague-request handling) -
      // Sits BEFORE the planner and improves the input sent to it. It turns
      // vague/messy requests ("make this cool", "make a reel") into a guided
      // question (reusing pendingClarify + QuickReplies), builds a stable
      // EditBrief across turns, and — when enough info exists — compiles a
      // clean, professional prompt for the planner. It is conservative and
      // ADDITIVE: it only shepherds fresh creation requests, never refinements
      // (a plan already exists), describe/vision asks, or fast commands — all
      // of which it passes straight through to the unchanged paths below.
      try {
        const { runIntake } = await import("@/lib/agentic-intake/runIntake");
        const intake = runIntake(userRequest, {
          // The editor always has the /api/agent path; the local planner is
          // gated by its own flags + WebGPU inside tryLocalPlannerRecovery.
          cloudAvailable: true,
          localPlannerAvailable: false,
          cloudVisionAvailable: true
        });
        if (intake.kind === "clarify") {
          // Ask ONE focused question with option chips. No raw-text echo.
          pushMessage({
            role: "assistant",
            content: intake.message,
            attachment: { mode: "intake", field: intake.question.id }
          });
          setPendingClarify({
            message: intake.message,
            questions: [intake.question]
          });
          logSession.ai(
            "intake.clarify",
            { field: intake.question.id, missing: intake.brief.missing },
            intake.message
          );
          setBusy(false);
          return;
        }
        if (intake.kind === "proceed") {
          // Enough info — hand a clean compiled prompt to the local-planner
          // fallback and clear any stale clarify. The cloud planner still runs
          // on the full conversation; this only improves the offline path.
          intakeCompiledPrompt = intake.compiledPrompt;
          useEditorStore.getState().setPendingClarify(null);
          logSession.ai(
            "intake.proceed",
            { route: intake.route.target, intent: intake.brief.intentKind },
            intake.summary
          );
        }
        // intake.kind === "passthrough" → leave everything to the paths below.
      } catch (err) {
        logSession.system(
          "intake.path.failed",
          { message: (err as Error).message, userRequest },
          `Intake layer errored, falling back: ${(err as Error).message.slice(0, 80)}`
        );
      }

      // ---- v1.7.5 — Client-side intent shortcut gate -----------------
      // Try to dispatch the turn locally before paying for a cloud
      // planner round-trip. The grammar-based matcher only fires on
      // high-confidence patterns (>= 0.85); everything else falls
      // through to the cloud path below. See lib/intent/quickMatch.ts
      // for the boundary docblock — this does NOT bypass the planner's
      // "no keyword heuristics" rule because the cloud planner is
      // unchanged; this is purely a fast path on top of it.
      //
      // The intent module (compromise + dispatch + patterns) is
      // dynamic-imported so the ~140 KB compromise weight lives in a
      // separate chunk loaded on first chat turn rather than on the
      // initial /editor visit.
      try {
        const { tryQuickShortcut } = await import("@/lib/intent/dispatch");
        const fast = await tryQuickShortcut(userRequest, {
          pushMessage,
          setStatus,
          setProgress,
          setInferred,
          setHighlights,
          setPendingClarify,
          setPendingExecution,
          handleRunPipeline: () =>
            void handleRunPipelineRef.current?.(),
          logSession,
          sessionId
        });
        if (fast) {
          // The shortcut handled the turn end-to-end. Skip the cloud
          // call entirely. Activity log already recorded by the
          // shortcut path.
          //
          // v1.7.8 — IMPORTANT: clear the busy flag here. The cloud
          // path's `finally` block does not run on this early return,
          // so without this call the chat stayed stuck on "Working…"
          // indefinitely after every successful quick-shortcut.
          setBusy(false);
          return;
        }
      } catch (err) {
        // Quick-match failures are benign; fall through to cloud.
        // We log so the dev tester / activity drawer surface the issue.
        logSession.system(
          "intent.shortcut.failed",
          { message: (err as Error).message, userRequest },
          `Shortcut path errored, falling back to cloud: ${(err as Error).message.slice(0, 80)}`
        );
      }
      // ---- Cloud planner ---------------------------------------------
      // The browser WebLLM local-first router was removed; language/tool
      // routing now happens server-side via /api/agent (OpenRouter →
      // Gemini → Groq). The deterministic quick-shortcut gate above still
      // handles high-confidence turns without a round-trip.
      //
      // v1.9.x — an OPTIONAL on-device WebLLM planner is re-introduced as a
      // SECOND-tier fallback (cloud → local → manual), gated behind
      // NEXT_PUBLIC_LOCAL_LLM_* flags and WebGPU. It is text-only and never
      // loads on page load — see lib/local-llm/*. This helper performs the
      // local recovery attempt and is invoked only when the cloud call
      // below fails.
      const tryLocalPlannerRecovery = async (
        req: string
      ): Promise<LocalRecovery> => {
        const { LOCAL_LLM } = await import("@/lib/local-llm/config");
        if (!LOCAL_LLM.enabled || !LOCAL_LLM.autoFallback) {
          return { outcome: "none" };
        }
        const { isWebGPUAvailable } = await import("@/lib/local-llm/webllm");
        const { setLocalAIStatus } = await import("@/lib/local-llm/status");
        // No WebGPU → fail gracefully; the manual editor keeps working.
        if (!isWebGPUAvailable()) {
          setLocalAIStatus({ mode: "manual", phase: "idle" });
          return { outcome: "none" };
        }
        try {
          setStatus("planning", "Cloud AI unavailable \u2014 trying local AI\u2026");
          const { tryLocalPlannerFallback } = await import(
            "@/lib/local-llm/localPlanner"
          );
          const local = await tryLocalPlannerFallback(req, {
            videoDurationSeconds: videoMeta?.duration,
            compiledPrompt: intakeCompiledPrompt
          });
          if (local && local.kind === "plan") {
            logSession.ai(
              "local.planner.used",
              { request: req.slice(0, 120) },
              "Planned on-device with local AI (WebLLM)"
            );
            return {
              outcome: "planned",
              response: {
                mode: "plan",
                plan: local.plan,
                message: local.message,
                inferred: [],
                warnings: [
                  "Cloud AI was unavailable \u2014 planned locally on your device."
                ]
              }
            };
          }
          if (local && local.kind === "unsupported") {
            // Truthful: local AI can plan edits but cannot watch frames.
            setLocalAIStatus({
              mode: "manual",
              phase: "ready",
              text: "Local AI ready (text only)"
            });
            pushMessage({
              role: "assistant",
              content:
                "Local AI is available for edit planning, but local video-frame vision is not enabled yet. I couldn't reach the cloud to analyse the footage \u2014 try again in a moment, or tell me what to clip and I'll plan it locally."
            });
            setStatus(
              useEditorStore.getState().highlights.length > 0 ? "ready" : "idle",
              undefined
            );
            setProgress(0);
            return { outcome: "handled" };
          }
          // local === null → engine missing/failed/unparseable.
          setLocalAIStatus({ mode: "manual", phase: "error", text: "Local AI unavailable" });
          return { outcome: "none" };
        } catch (err) {
          setLocalAIStatus({ mode: "manual", phase: "error", text: "Local AI unavailable" });
          logSession.system(
            "local.planner.failed",
            { message: (err as Error).message },
            `Local planner failed: ${(err as Error).message.slice(0, 80)}`
          );
          return { outcome: "none" };
        }
      };

      try {
        setStatus("planning", "Talking to the planner");
        setProgress(0.05);

        const history = [...useEditorStore.getState().messages];
        const recentActivity = summarizeRecentActivity();
        // v1.6.0 — Build the planner-visible library snapshot. Names,
        // dimensions, aspect, selected flag, plus any per-source notes
        // accumulated from acknowledge-mode chips. The LLM uses this to
        // emit "sources": [...] when the user names specific videos.
        const storeNow = useEditorStore.getState();
        const videoLibrary: VideoLibraryEntry[] | undefined =
          storeNow.sources.length > 0
            ? storeNow.sources.map((s) => {
                // Per-source notes: pluck any inferred chip whose
                // "field" mentions this source's name. We don't yet
                // attach inferred chips to a sourceId explicitly, so
                // we surface the global chip list per source for now —
                // the planner is told to treat the global notes as
                // applying across the library.
                const notes = storeNow.inferred
                  .filter(
                    (c) =>
                      c.field.toLowerCase().includes("avoid") ||
                      c.field.toLowerCase().includes("style") ||
                      c.field.toLowerCase().includes("note")
                  )
                  .map((c) => `${c.field}: ${formatChipValue(c.value)}`)
                  .slice(0, 4);
                return {
                  id: s.id,
                  name: s.meta.name,
                  duration: s.meta.duration,
                  width: s.meta.width,
                  height: s.meta.height,
                  aspect: s.meta.aspect,
                  selected: storeNow.selectedSourceIds.includes(s.id),
                  notes: notes.length > 0 ? notes : undefined
                };
              })
            : undefined;
        const reqBody: AgentRequest = {
          messages: history,
          currentPlan: previousPlan,
          videoMeta: videoMeta
            ? {
                duration: videoMeta.duration,
                width: videoMeta.width,
                height: videoMeta.height
              }
            : undefined,
          videoLibrary,
          activeSourceId: storeNow.activeSourceId ?? undefined,
          highlightsCount: storeNow.highlights.length,
          selectedClipId: storeNow.selectedClipId,
          // v1.6.4 — compact clip list so the planner can resolve
          // phrases like "clip 2" / "this clip" to a clipId for the
          // new describe mode (and improves edit-mode targeting too).
          timelineClips: storeNow.highlights.length > 0
            ? storeNow.highlights.map((h) => ({
                id: h.id,
                start: h.start,
                end: h.end,
                sourceId: h.sourceId,
                label: h.label
              }))
            : undefined,
          memory,
          recentActivity: recentActivity || undefined,
          // v1.7.2 — surface the most recent briefing so the planner
          // can emit `mode: "promote"` when the user says things like
          // "clip those", "use the second one", "make a 30s reel of
          // these". The planner sees each best part by id and time
          // range; the client converts back to highlights without
          // another vision call. Limited to bestParts only — the
          // overview text is irrelevant for promotion decisions and
          // would just bloat the prompt.
          lastBriefing: storeNow.lastBriefing
            ? {
                sourceId: storeNow.lastBriefing.sourceId,
                sourceName: storeNow.lastBriefing.sourceName,
                bestParts: storeNow.lastBriefing.bestParts.map((p) => ({
                  id: p.id,
                  startSeconds: p.startSeconds,
                  endSeconds: p.endSeconds,
                  label: p.label,
                  why: p.why
                }))
              }
            : undefined
        };
        const t0 = Date.now();
        const planResp = await fetch("/api/agent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(reqBody)
        });
        let data = (await planResp.json().catch(() => ({}))) as AgentResponse;
        const plannerMs = Date.now() - t0;

        // ---- error mode ---------------------------------------------------
        if (!planResp.ok || data.mode === "error") {
          // ---- Provider router tier 2: optional LOCAL WebLLM planner -----
          // The cloud planner failed (overload, quota, network, 402, etc.).
          // When the local-LLM feature is enabled AND auto-fallback is on AND
          // the browser has WebGPU, try to plan this turn entirely on-device.
          // WebLLM is text-only — it can plan edits but cannot watch frames.
          // Everything is lazy-loaded here so nothing touches page load.
          const cloudErr =
            data.mode === "error"
              ? data.error
              : `Planner returned ${planResp.status}`;
          const cloudErrStatus = planResp.status;
          const cloudRetryAfter =
            data.mode === "error" ? data.retryAfterSeconds : undefined;

          const localOutcome = await tryLocalPlannerRecovery(userRequest);
          if (localOutcome.outcome === "planned") {
            // Continue into the normal plan-handling path with the
            // locally-produced plan. The in-browser pipeline runs unchanged.
            data = localOutcome.response;
          } else if (localOutcome.outcome === "handled") {
            // The local path already pushed a truthful message (e.g. it was
            // a vision/describe ask local AI can't satisfy).
            return;
          } else {
            // No local recovery → surface the original cloud error.
            pushMessage({ role: "assistant", content: cloudErr });
            setStatus("failed", cloudErr);
            setProgress(0);
            if (cloudErrStatus === 429 || cloudErrStatus === 503) {
              logSession.system(
                "ratelimit.hit",
                {
                  layer: "agent",
                  status: cloudErrStatus,
                  retryAfterSeconds: cloudRetryAfter
                },
                `Rate-limited (${cloudErrStatus})`
              );
            }
            return;
          }
        }

        // ---- soft-tier quota banner --------------------------------------
        if ("quotaWarning" in data && data.quotaWarning) {
          setQuota(data.quotaWarning);
        }

        // ---- LLM-classified user tier (v1.4.0) ----------------------------
        // The planner emits userTier directly from tone/vocabulary —
        // there is no client-side classification anymore. Persist it so
        // both the auto-run and the PlanPreview confirm path read the
        // same value.
        if (
          (data.mode === "plan" || data.mode === "moment") &&
          data.userTier
        ) {
          setUserTier(data.userTier);
        }

        // ---- ACKNOWLEDGE (v1.5.2) -----------------------------------------
        // Context-update turn. The user told us a fact about the
        // footage rather than asking for a new edit ("there's a defeat
        // title", "this is 4K", "the audio is bad"). We confirm we
        // heard them, surface any inferred chips, and leave the plan,
        // clips, and pipeline state exactly as they were. We deliberately
        // do NOT touch `mode` in the store — the user's last action mode
        // (plan/moment) stays active so a follow-up refinement still
        // patches the right plan.
        if (data.mode === "acknowledge") {
          if (data.inferred && data.inferred.length > 0) {
            // Merge with any existing chips so we accumulate context
            // across multiple acknowledge turns instead of clobbering.
            // Dedupe by (field, value) using JSON.stringify so array
            // values like ["defeat title cards"] compare correctly.
            const existing = useEditorStore.getState().inferred ?? [];
            const seen = new Set(
              existing.map((c) => `${c.field}::${JSON.stringify(c.value)}`)
            );
            const combined: InferredField[] = [...existing];
            for (const ch of data.inferred) {
              const key = `${ch.field}::${JSON.stringify(ch.value)}`;
              if (!seen.has(key)) {
                seen.add(key);
                combined.push(ch);
              }
            }
            // Cap at 8 so the chip row doesn't grow unbounded.
            setInferred(combined.slice(-8));
          }
          pushMessage({
            role: "assistant",
            content: data.message || "Got it \u2014 I'll keep that in mind."
          });
          // Status reflects whatever the previous turn left us in. If
          // there's an active plan we stay "ready", otherwise idle.
          const hasReadyClips =
            useEditorStore.getState().highlights.length > 0;
          setStatus(hasReadyClips ? "ready" : "idle", undefined);
          logSession.ai(
            "context.note",
            {
              note: userRequest.slice(0, 200),
              inferred: data.inferred ?? []
            },
            `Noted context: ${userRequest.slice(0, 60)}`,
            plannerMs
          );
          return;
        }

        // ---- EDIT mode (v1.6.1) ------------------------------------------
        // Direct timeline mutation. The LLM emitted a list of structured
        // ops; we apply them sequentially using existing store actions.
        // Per-op `sourceId` swaps the active source in/out so each op
        // hits the right footage. The pipeline does NOT run.
        if (data.mode === "edit") {
          const ops = data.operations ?? [];
          if (ops.length === 0) {
            pushMessage({
              role: "assistant",
              content: data.message || "No edits to apply."
            });
            setStatus("idle", undefined);
            return;
          }
          // v1.7.9 — "undo" must work even with an empty timeline (the
          // user may be recovering from a wipe), so let it past the
          // empty-timeline guard below.
          const hasUndoOp = ops.some((o) => o.kind === "undo");
          if (highlights.length === 0 && !hasUndoOp) {
            pushMessage({
              role: "assistant",
              content:
                "No clips on the timeline to edit yet. Tell me what kind of short you want first."
            });
            setStatus("idle", undefined);
            return;
          }
          const store = useEditorStore.getState();
          const originalActive = store.activeSourceId;
          let totalChanged = 0;
          const opLog: Array<{ kind: string; payload: unknown; changed: number }> = [];
          for (const op of ops) {
            // Switch active source if the op targets a specific one. We
            // restore at the end so the preview pane stays where the
            // user left it.
            if (op.sourceId && op.sourceId !== useEditorStore.getState().activeSourceId) {
              const exists = useEditorStore
                .getState()
                .sources.some((s) => s.id === op.sourceId);
              if (exists) useEditorStore.getState().setActiveSource(op.sourceId);
            }
            const s = useEditorStore.getState();
            let result = { changed: 0 };
            switch (op.kind) {
              case "trim_first":
                result = s.trimFirstSeconds(op.seconds);
                break;
              case "trim_last":
                result = s.trimLastSeconds(op.seconds);
                break;
              case "keep_range":
                result = s.keepRange(op.startSeconds, op.endSeconds);
                break;
              case "drop_range":
                result = s.dropRange(op.startSeconds, op.endSeconds);
                break;
              case "split_at":
                result = s.splitAtTime(op.timeSeconds);
                break;
              case "split_selected": {
                const sel = s.highlights.find(
                  (h) => h.id === s.selectedClipId
                );
                if (sel) {
                  const mid = sel.start + (sel.end - sel.start) / 2;
                  result = s.splitAtTime(mid);
                }
                break;
              }
              case "reset_source":
                result = s.resetActiveSourceClips();
                break;
              case "undo": {
                const r = s.undoTimeline();
                // Report a clip-change count so the summary message
                // reads naturally ("1 clip change") when something was
                // actually restored.
                result = { changed: r.restored ? 1 : 0 };
                break;
              }
            }
            totalChanged += result.changed;
            opLog.push({
              kind: op.kind,
              payload: { ...op, sourceId: op.sourceId ?? null },
              changed: result.changed
            });
          }
          // Restore original active source if a specific op switched it.
          if (
            originalActive &&
            useEditorStore.getState().activeSourceId !== originalActive
          ) {
            useEditorStore.getState().setActiveSource(originalActive);
          }
          if (data.inferred && data.inferred.length > 0) {
            setInferred(data.inferred);
          }
          pushMessage({
            role: "assistant",
            content:
              data.message ||
              (totalChanged === 0
                ? "Nothing matched those edits."
                : `Applied ${ops.length} edit${ops.length === 1 ? "" : "s"} (${totalChanged} clip change${totalChanged === 1 ? "" : "s"}).`)
          });
          const stateAfter = useEditorStore.getState();
          setStatus(
            stateAfter.highlights.length > 0 ? "ready" : "idle",
            undefined
          );
          logSession.ai(
            "edit.applied",
            { ops: opLog, totalChanged },
            `Applied ${ops.length} edit op${ops.length === 1 ? "" : "s"} (${totalChanged} clip change${totalChanged === 1 ? "" : "s"})`,
            plannerMs
          );
          return;
        }

        // ---- DESCRIBE mode (v1.6.4) ---------------------------------------
        // Clip-level Q&A. The LLM identified the user as asking about
        // an existing clip. We resolve the target into a (sourceBlob,
        // start, end) tuple, sample ~6 frames in that range, base64 them,
        // and POST to /api/vision/clip. The vision model's answer is
        // rendered as a follow-up assistant message. Plan + clip state
        // stay untouched.
        if (data.mode === "describe") {
          const target = data.target;
          const question = data.question;
          // Show the WHILE-RUNNING message immediately so the user
          // doesn't stare at a blank chat.
          pushMessage({
            role: "assistant",
            content: data.message || "Looking at that clip\u2026"
          });
          if (data.inferred && data.inferred.length > 0) {
            setInferred(data.inferred);
          }

          // Resolve target → { source, start, end }.
          const storeState = useEditorStore.getState();
          let resolvedSource: typeof storeState.sources[number] | undefined;
          let rangeStart = 0;
          let rangeEnd = 0;
          let resolvedClipLabel: string | undefined;

          if (target.kind === "clip") {
            const clip = storeState.highlights.find(
              (h) => h.id === target.clipId
            );
            if (!clip) {
              pushMessage({
                role: "assistant",
                content:
                  "I couldn't find that clip on the timeline anymore \u2014 it may have been removed."
              });
              return;
            }
            const sid =
              clip.sourceId ?? storeState.activeSourceId ?? undefined;
            resolvedSource = storeState.sources.find((s) => s.id === sid);
            if (!resolvedSource) {
              pushMessage({
                role: "assistant",
                content:
                  "The video this clip belongs to isn't loaded \u2014 re-upload it and try again."
              });
              return;
            }
            rangeStart = clip.start;
            rangeEnd = clip.end;
            resolvedClipLabel = clip.label;
          } else {
            // range mode
            const sid = target.sourceId ?? storeState.activeSourceId;
            resolvedSource = storeState.sources.find((s) => s.id === sid);
            if (!resolvedSource) {
              pushMessage({
                role: "assistant",
                content:
                  "Upload a video first, then ask about a clip in it."
              });
              return;
            }
            rangeStart = Math.max(
              0,
              Math.min(resolvedSource.meta.duration, target.startSeconds)
            );
            rangeEnd = Math.max(
              rangeStart + 0.5,
              Math.min(resolvedSource.meta.duration, target.endSeconds)
            );
          }

          // Extract frames + describe via cloud vision.
          try {
            setStatus("scoring", "Reading frames\u2026");
            setProgress(0.3);
            const frames = await sampleClipForDescribe({
              blob: resolvedSource.blob,
              startSeconds: rangeStart,
              endSeconds: rangeEnd,
              targetCount: 6
            });
            setProgress(0.6);
            const resp = await fetch("/api/vision/clip", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                question,
                clipStart: rangeStart,
                clipEnd: rangeEnd,
                sourceName: resolvedSource.meta.name,
                frames: frames.map((f) => ({
                  t: f.t,
                  imageBase64: f.base64
                }))
              })
            });
            const json = (await resp.json().catch(() => ({}))) as {
              description?: string;
              enterTime?: number;
              exitTime?: number;
              keyMoments?: Array<{ t: number; what: string }>;
              error?: string;
              transient?: boolean;
            };
            if (!resp.ok || json.error) {
              const base =
                json.error ||
                "Couldn't analyze that clip right now \u2014 try again in a sec.";
              pushMessage({
                role: "assistant",
                content: LOCAL_LLM.enabled
                  ? `${base} (Local AI can plan edits on-device, but it can't watch video frames yet.)`
                  : base
              });
              setStatus(
                storeState.highlights.length > 0 ? "ready" : "idle",
                undefined
              );
              setProgress(0);
              return;
            }

            // Build a friendly answer message. We append optional
            // structured fields as inline cues at the end so the user
            // sees the timestamps without the LLM having to embed them
            // in prose.
            const parts: string[] = [json.description?.trim() || "Here's what I see."];
            const cues: string[] = [];
            if (typeof json.enterTime === "number") {
              cues.push(`enters at ${formatT(json.enterTime)}`);
            }
            if (typeof json.exitTime === "number") {
              cues.push(`exits at ${formatT(json.exitTime)}`);
            }
            if (cues.length > 0) parts.push(`(${cues.join(", ")})`);
            if (json.keyMoments && json.keyMoments.length > 0) {
              parts.push(
                "Key beats: " +
                  json.keyMoments
                    .slice(0, 4)
                    .map((m) => `${formatT(m.t)} ${m.what}`)
                    .join("; ")
              );
            }
            pushMessage({
              role: "assistant",
              content: parts.join(" ")
            });

            setStatus(
              storeState.highlights.length > 0 ? "ready" : "idle",
              undefined
            );
            setProgress(1);
            logSession.ai(
              "describe.answered",
              {
                target,
                question: question.slice(0, 120),
                rangeSeconds: round1(rangeEnd - rangeStart),
                framesSent: frames.length,
                hasEnter: typeof json.enterTime === "number",
                hasExit: typeof json.exitTime === "number",
                keyMoments: json.keyMoments?.length ?? 0,
                clipLabel: resolvedClipLabel
              },
              `Described clip ${rangeStart.toFixed(1)}s\u2013${rangeEnd.toFixed(1)}s`,
              plannerMs
            );
          } catch (err) {
            pushMessage({
              role: "assistant",
              content: `Couldn't analyze that clip: ${(err as Error).message}`
            });
            setStatus(
              storeState.highlights.length > 0 ? "ready" : "idle",
              undefined
            );
            setProgress(0);
            logSession.system(
              "error.unhandled",
              { phase: "describe", message: (err as Error).message },
              `Describe failed: ${(err as Error).message.slice(0, 80)}`
            );
          }
          return;
        }

        // ---- BRIEFING mode (v1.7.0) ---------------------------------------
        // The user wants the AI to *describe* the video / call out best
        // parts WITHOUT producing a render. The planner forwarded a
        // sample plan + the question; we sample frames here and POST
        // them to /api/agent/briefing for the structured analysis. The
        // result is pushed into chat as an assistant message carrying
        // the BriefingResult as an attachment so AssistantPanel can
        // render the BriefingCard. Plan + clip state stay untouched.
        if (data.mode === "briefing") {
          const storeState = useEditorStore.getState();
          const active =
            storeState.sources.find((s) => s.id === storeState.activeSourceId) ??
            storeState.sources[0];
          if (!active) {
            pushMessage({
              role: "assistant",
              content:
                "Upload a video first, then I can describe what's in it."
            });
            setStatus("idle", "Awaiting video");
            setProgress(0);
            return;
          }

          // Show the warm waiting message immediately; the structured
          // briefing result lands as a follow-up message once the
          // vision call returns.
          pushMessage({
            role: "assistant",
            content: data.message || "Watching the whole thing now\u2026"
          });
          if (data.inferred && data.inferred.length > 0) {
            setInferred(data.inferred);
          }

          try {
            setStatus("scoring", "Reading frames\u2026");
            setProgress(0.2);

            const duration = active.meta.duration;
            const rangeStart = data.samplePlan.range
              ? Math.max(0, data.samplePlan.range.startSeconds)
              : 0;
            const rangeEnd = data.samplePlan.range
              ? Math.min(duration, data.samplePlan.range.endSeconds)
              : duration;
            const targetCount = data.samplePlan.count;
            const span = Math.max(0.5, rangeEnd - rangeStart);
            const every = Math.max(0.5, span / Math.max(1, targetCount - 1));

            const { sampleFrames, blobToBase64 } = await import(
              "@/lib/pipeline/sample"
            );
            const frames = await sampleFrames(active.blob, {
              every,
              width: 384,
              range: { startSeconds: rangeStart, endSeconds: rangeEnd },
              maxFrames: targetCount + 2
            });
            const sliced = frames.slice(0, targetCount);
            if (sliced.length < 3) {
              pushMessage({
                role: "assistant",
                content:
                  "I couldn't pull enough frames to brief you on this video. Try a longer source."
              });
              setStatus("idle", undefined);
              setProgress(0);
              return;
            }
            setProgress(0.6);

            const framesB64: Array<{ t: number; imageBase64: string }> = [];
            for (const f of sliced) {
              framesB64.push({ t: f.t, imageBase64: await blobToBase64(f.blob) });
            }

            const resp = await fetch("/api/agent/briefing", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                question: data.question,
                sourceName: active.meta.name,
                duration,
                range: data.samplePlan.range,
                frames: framesB64
              })
            });
            const json = (await resp.json().catch(() => ({}))) as {
              overview?: string;
              bestParts?: Array<{
                id: string;
                startSeconds: number;
                endSeconds: number;
                label: string;
                why: string;
                sourceId?: string;
              }>;
              followUps?: string[];
              error?: string;
              transient?: boolean;
            };
            if (!resp.ok || json.error) {
              const base =
                json.error ||
                "Couldn't analyse the video right now \u2014 try again in a sec.";
              pushMessage({
                role: "assistant",
                content: LOCAL_LLM.enabled
                  ? `${base} (Local AI is available for edit planning, but local video-frame vision is not enabled yet.)`
                  : base
              });
              setStatus(
                storeState.highlights.length > 0 ? "ready" : "idle",
                undefined
              );
              setProgress(0);
              return;
            }

            // Tag the assistant message with a briefing attachment so
            // AssistantPanel can render the structured card. The
            // visible content is the overview text — the card adds
            // bestParts + followUps below it.
            const briefingMsg = pushMessage({
              role: "assistant",
              content: json.overview || "Here's what I see.",
              attachment: {
                mode: "briefing",
                bestParts: json.bestParts ?? [],
                followUps: json.followUps ?? [],
                sourceId: active.id
              }
            });

            // v1.7.2 — store the briefing so future turns can promote
            // its bestParts directly into timeline clips without
            // re-running vision. Keyed by the chat message id so the
            // user can refer to it ("clip those") and the planner can
            // see the parts in the AgentRequest's lastBriefing block.
            useEditorStore.getState().setLastBriefing({
              id: briefingMsg.id,
              sourceId: active.id,
              sourceName: active.meta.name,
              bestParts: json.bestParts ?? [],
              ts: Date.now()
            });

            setStatus(
              storeState.highlights.length > 0 ? "ready" : "idle",
              undefined
            );
            setProgress(1);
            logSession.ai(
              "briefing.delivered",
              {
                question: data.question.slice(0, 120),
                framesSent: framesB64.length,
                rangeStart,
                rangeEnd,
                bestPartsCount: json.bestParts?.length ?? 0,
                followUpsCount: json.followUps?.length ?? 0
              },
              `Briefed ${(rangeEnd - rangeStart).toFixed(0)}s of "${active.meta.name}"`,
              plannerMs
            );
          } catch (err) {
            pushMessage({
              role: "assistant",
              content: `Briefing failed: ${(err as Error).message}`
            });
            setStatus(
              useEditorStore.getState().highlights.length > 0 ? "ready" : "idle",
              undefined
            );
            setProgress(0);
            logSession.system(
              "error.unhandled",
              { phase: "briefing", message: (err as Error).message },
              `Briefing failed: ${(err as Error).message.slice(0, 80)}`
            );
          }
          return;
        }

        // ---- EXTRACT mode (v1.5.0) ----------------------------------------
        // Verbatim time slice. No scoring, no Gemini vision call. The
        // pipeline emits exactly one Highlight for the requested range.
        if (data.mode === "extract") {
          if (!videoBlob || !videoHash || !videoMeta) {
            pushMessage({
              role: "assistant",
              content: "Upload a video first, then I can grab that slice."
            });
            setStatus("idle", "Awaiting video");
            setProgress(0);
            return;
          }
          setMode("extract");
          setInferred(data.inferred ?? []);
          setPendingClarify(null);
          pushMessage({
            role: "assistant",
            content: data.message || "Grabbing that slice."
          });
          const built = buildExtractedHighlight({
            range: data.extractRange,
            videoDuration: videoMeta.duration,
            transition: "none"
          });
          if (built.length === 0) {
            pushMessage({
              role: "assistant",
              content:
                "That range doesn't fit inside this video. Try a different start or end."
            });
            setStatus("ready", "Range out of bounds");
            setProgress(0);
            return;
          }
          // v1.7.9 — Extract joins the timeline ADDITIVELY by default,
          // so a second "clip 2:00 to 2:30" stacks on the first slice
          // instead of erasing it. The planner emits op:"replace" only
          // on explicit reset language. We tag the slice with the active
          // source id and allow overlap — the user pinned this exact
          // range, so it must never be deduped away.
          const extractActiveId =
            useEditorStore.getState().activeSourceId ?? undefined;
          const taggedExtract = built.map((h) => ({
            ...h,
            sourceId: h.sourceId ?? extractActiveId
          }));
          const extractAppend =
            data.op !== "replace" &&
            useEditorStore.getState().highlights.length > 0;
          if (extractAppend) {
            useEditorStore
              .getState()
              .mergeHighlights(taggedExtract, { allowOverlap: true });
            const finalCount = useEditorStore.getState().highlights.length;
            pushMessage({
              role: "assistant",
              content: `Added that slice \u2014 ${finalCount} clip${finalCount === 1 ? "" : "s"} on the timeline now.`
            });
          } else {
            setHighlights(taggedExtract);
          }
          setStatus("ready", "Ready to render");
          setProgress(1);
          logSession.ai(
            "extract.applied",
            {
              kind: data.extractRange.kind,
              start: built[0].start,
              end: built[0].end,
              durationSec: built[0].end - built[0].start
            },
            `Extracted ${built[0].start.toFixed(1)}s \u2192 ${built[0].end.toFixed(1)}s verbatim`,
            plannerMs
          );
          return;
        }

        // ---- MERGE mode (v1.7.4) ------------------------------------------
        // The user wants the whole videos concatenated as-is — no
        // scoring, no clipping, no edit. The agent route forwarded
        // (sourceIds, transition, format, op); we resolve which
        // sources to use, build one full-duration Highlight per
        // source, and put them on the timeline ready to render.
        // The pipeline does NOT run.
        if (data.mode === "merge") {
          const storeState = useEditorStore.getState();
          const allSources = storeState.sources;
          if (allSources.length === 0) {
            pushMessage({
              role: "assistant",
              content: "Upload at least one video first, then I can merge."
            });
            setStatus("idle", "Awaiting video");
            setProgress(0);
            return;
          }

          // Resolve which sources are in scope. Priority:
          //   1. Explicit sourceIds from the planner (in user-named order).
          //   2. selectedSourceIds (the AI-eligible set).
          //   3. All sources in library order.
          let chosen: typeof allSources;
          if (data.sourceIds && data.sourceIds.length > 0) {
            const wanted = new Set(data.sourceIds);
            // Preserve the planner-supplied ORDER. The library is
            // typically a small array so a per-id linear lookup is
            // fine — and we WANT the ordering the LLM produced when
            // the user said e.g. "merge the podcast then the b-roll".
            chosen = data.sourceIds
              .map((id) => allSources.find((s) => s.id === id))
              .filter((s): s is (typeof allSources)[number] => Boolean(s));
            // Backstop: if the planner asked for ids that don't exist
            // (drift between client and server), drop unknown ids and
            // fall back to selected sources for any remaining slots.
            if (chosen.length === 0) {
              chosen = allSources.filter((s) =>
                storeState.selectedSourceIds.includes(s.id)
              );
            } else {
              void wanted;
            }
          } else {
            chosen = allSources.filter((s) =>
              storeState.selectedSourceIds.includes(s.id)
            );
          }
          if (chosen.length === 0) {
            // Final fallback: every source in library order. Better to
            // do something sensible than to error out on an obviously
            // valid intent.
            chosen = allSources;
          }

          const transition = data.transition ?? "none";

          // Build one full-duration highlight per chosen source. score
          // is 1.0 (this is user-explicit, not a model match) so the
          // confidence chip shows "high" without polluting future
          // scoring runs.
          const { newId } = await import("@/lib/util/id");
          const newHighlights = chosen.map((src, i) => ({
            id: newId("clip"),
            start: 0,
            end: round2(src.meta.duration),
            score: 1,
            reason: "Full source merged as-is",
            label: src.meta.name,
            transition: i === 0 ? ("none" as const) : transition,
            confidence: "high" as const,
            sourceId: src.id
          }));

          if (data.op === "append") {
            useEditorStore.getState().mergeHighlights(newHighlights);
          } else {
            setHighlights(newHighlights);
          }

          // Switch active source to the first merged source so the
          // preview pane shows the start of the merge.
          const firstId = chosen[0]?.id;
          if (firstId && firstId !== storeState.activeSourceId) {
            useEditorStore.getState().setActiveSource(firstId);
          }

          if (data.inferred && data.inferred.length > 0) {
            setInferred(data.inferred);
          }

          const totalSeconds = newHighlights.reduce(
            (acc, h) => acc + (h.end - h.start),
            0
          );
          const summary =
            chosen.length === 1
              ? `On the timeline as one ${totalSeconds.toFixed(1)}s clip from "${chosen[0].meta.name}". Tap "Render" to assemble.`
              : `Merged ${chosen.length} videos in order — ${totalSeconds.toFixed(1)}s total. Tap "Render" to assemble.`;
          pushMessage({
            role: "assistant",
            content: data.message
              ? `${data.message} ${summary}`
              : `Merging the videos as-is. ${summary}`
          });
          setStatus("ready", "Ready to render");
          setProgress(1);
          logSession.ai(
            "merge.applied",
            {
              sourceCount: chosen.length,
              sourceIds: chosen.map((s) => s.id),
              totalSeconds: round1(totalSeconds),
              transition,
              op: data.op ?? "replace"
            },
            `Merged ${chosen.length} source${chosen.length === 1 ? "" : "s"} (${totalSeconds.toFixed(1)}s)`,
            plannerMs
          );
          return;
        }

        // ---- COMPOSE mode (v1.8.0) ----------------------------------------
        // Multi-source montage. The user referenced clips from MORE THAN
        // ONE uploaded video and asked to combine them ("combat in the
        // first video and the cutscene in the second, make it
        // transition"). We resolve each source ref against the live
        // library, run the REAL per-source vision pipeline
        // (executeForSource) for each, then assemble a FRESH ordered
        // montage and lay it on the timeline via setHighlights — which
        // snapshots the prior timeline so the user can undo. Original
        // uploads are never mutated. (Option A: single shared timeline;
        // a true second slot is a future architecture change.)
        if (data.mode === "compose") {
          const compose = data.compose;
          const composeStore = useEditorStore.getState();
          const allSources = composeStore.sources;
          // Compose needs at least two uploads in the library. If only one
          // (or none) exists, ask for a second instead of dropping into a
          // single-source plan or a generic topic question.
          if (allSources.length < 2) {
            const wantTwo = compose.sources
              .slice(0, 2)
              .map((s) => (s.query || "").trim())
              .filter(Boolean);
            const example =
              wantTwo.length >= 2
                ? `${wantTwo[0]} from the first and ${wantTwo[1]} from the second`
                : "the right moments from each video";
            pushMessage({
              role: "assistant",
              content:
                allSources.length === 0
                  ? "Upload two videos first, then I\u2019ll combine moments from each into one montage."
                  : `Upload or select a second video first, then I\u2019ll combine ${example}.`
            });
            setStatus(allSources.length === 0 ? "idle" : "ready", undefined);
            setProgress(0);
            return;
          }

          const resolvable: ResolvableSource[] = allSources.map((s, i) => ({
            id: s.id,
            name: s.meta.name,
            index: i,
            selected: composeStore.selectedSourceIds.includes(s.id),
            active: s.id === composeStore.activeSourceId
          }));

          // Issue #64 — ALL-SOURCES compose. The server can't enumerate the
          // library, so for sourceScope "all" we fan out across EVERY eligible
          // upload here, splitting the target duration evenly and using either
          // the one shared topic or broad visual-interest selection (generic
          // best parts). No fabricated per-source topics.
          let resolved: Array<{
            selection: ComposeSourceSelection;
            source: ResolvableSource;
          }>;
          let unresolved: ComposeSourceSelection[];
          if (compose.sourceScope === "all") {
            const eligible = resolvable.slice(0, VIDEO_PROMPT.maxComposeSources);
            const numSrc = eligible.length;
            const perSourceDuration =
              compose.targetSeconds && compose.targetSeconds > 0
                ? compose.targetSeconds / numSrc
                : undefined;
            resolved = eligible.map((source, i) => ({
              source,
              selection: {
                sourceRef: { type: "index", index: i },
                query: compose.allSourcesTopic ?? "",
                role: "segment" as ComposeRole,
                order: i + 1,
                ...(perSourceDuration
                  ? { durationSeconds: perSourceDuration }
                  : {})
              }
            }));
            unresolved = [];
          } else {
            const r = resolveComposeSources(compose.sources, resolvable);
            resolved = r.resolved;
            unresolved = r.unresolved;
          }

          if (resolved.length === 0) {
            pushMessage({
              role: "assistant",
              content:
                "I couldn't tell which uploads to combine. Try naming them \u2014 e.g. \u201cthe first video\u201d and \u201cthe second video\u201d."
            });
            setStatus(allSources.length > 0 ? "ready" : "idle", undefined);
            setProgress(0);
            return;
          }

          if (data.inferred && data.inferred.length > 0) {
            setInferred(data.inferred);
          }
          setPendingClarify(null);
          pushMessage({
            role: "assistant",
            content: data.message || "Building a combined montage."
          });

          const sourceById = new Map(allSources.map((s) => [s.id, s]));
          setStatus("planning", "Composing montage\u2026");
          setProgress(0.02);

          // Each collected clip carries the OrderableClip fields directly
          // (sourceOrder/userOrder/role + start/score from Highlight) plus
          // the query/sourceId we need for transitions + provenance.
          type ComposeClip = Highlight & {
            sourceOrder: number;
            userOrder?: number;
            role?: ComposeRole;
            query: string;
          };
          const collected: ComposeClip[] = [];
          const perSource: Array<{
            name: string;
            sourceId: string;
            count: number;
          }> = [];
          const userTier = composeStore.userTier;
          const t0 = Date.now();

          try {
            for (let i = 0; i < resolved.length; i++) {
              const { selection, source: rsrc } = resolved[i];
              const src = sourceById.get(rsrc.id);
              if (!src) continue;
              const subPlan = buildComposeSubPlan(selection, compose, i);
              const baseProgress = i / resolved.length;
              const slot = 1 / resolved.length;
              let result: Awaited<ReturnType<typeof executeForSource>>;
              try {
                result = await executeForSource({
                  source: src,
                  plan: subPlan,
                  mode: "plan",
                  capTier: cap.tier,
                  userTier,
                  log: logSession,
                  progress: {
                    setStatus: (s, detail) =>
                      setStatus(
                        s as Parameters<typeof setStatus>[0],
                        `${detail ?? s} (${i + 1}/${resolved.length})`
                      ),
                    setProgress: (p) =>
                      setProgress(Math.min(1, baseProgress + p * slot))
                  }
                });
              } catch (srcErr) {
                // One source failed to decode/analyze. ABORT the whole
                // compose WITHOUT touching the timeline — we never partially
                // replace it, so the user's previous montage/clips survive.
                const m = (srcErr as Error)?.message || String(srcErr);
                const ord = ["first", "second", "third", "fourth", "fifth"][i] ??
                  `#${i + 1}`;
                const decode = /decod|demux|codec|unsupported|moov|atom/i.test(m);
                pushMessage({
                  role: "assistant",
                  content: decode
                    ? `Couldn\u2019t decode the ${ord} video (\u201C${src.meta.name}\u201D) while building the combined montage. Try an H.264 MP4, or use a different upload. Your previous timeline was not changed.`
                    : `Couldn\u2019t analyze the ${ord} video (\u201C${src.meta.name}\u201D) while building the montage \u2014 ${m}. Your previous timeline was not changed.`
                });
                setStatus("failed", `Compose failed on "${src.meta.name}"`);
                setProgress(0);
                logSession.system(
                  "error.compose",
                  {
                    phase: "executeForSource",
                    sourceId: src.id,
                    sourceName: src.meta.name,
                    message: m
                  },
                  `Compose ${decode ? "decode" : "analysis"} error on "${src.meta.name}": ${m.slice(0, 80)}`
                );
                return;
              }

              // Take this source's best clips, then trim by clipCount /
              // durationSeconds if the user bounded the contribution.
              let clips = [...result.highlights].sort(
                (a, b) => b.score - a.score
              );
              if (selection.clipCount && selection.clipCount > 0) {
                clips = clips.slice(0, selection.clipCount);
              }
              if (selection.durationSeconds && selection.durationSeconds > 0) {
                const budget = selection.durationSeconds;
                let tot = 0;
                const kept: typeof clips = [];
                for (const c of clips) {
                  if (tot >= budget) break;
                  kept.push(c);
                  tot += c.end - c.start;
                }
                clips = kept;
              }
              clips.sort((a, b) => a.start - b.start);
              perSource.push({
                name: src.meta.name,
                sourceId: src.id,
                count: clips.length
              });
              for (const c of clips) {
                collected.push({
                  ...c,
                  sourceId: src.id,
                  sourceOrder: i,
                  userOrder: selection.order,
                  role: selection.role,
                  query: selection.query
                });
              }
            }

            if (collected.length === 0) {
              pushMessage({
                role: "assistant",
                content:
                  "I ran the analysis but couldn't find strong matches for what you asked. Try broader descriptions (e.g. \u201cfight scenes\u201d, \u201ctalking parts\u201d)."
              });
              setStatus("ready", "No strong matches");
              setProgress(0);
              return;
            }

            // Order the montage. Deterministic shuffle seed so the same
            // run is reproducible within a session.
            const seed = collected.length * 131 + resolved.length * 7 + 1;
            const ordered = orderComposedClips(
              collected,
              compose.ordering,
              makeRng(seed)
            );

            // Assign transitions per boundary (first clip never has an
            // incoming transition). Track which intended types we had to
            // map down so the summary can be honest about it.
            const { newId } = await import("@/lib/util/id");
            const intendedUsed = new Set<ComposeTransitionType>();
            const finalClips: Highlight[] = ordered.map((c, i) => {
              let render: RenderTransition = "none";
              if (i > 0) {
                const prev = ordered[i - 1];
                const t = resolveComposeTransition(
                  compose.transition,
                  { query: prev.query, role: prev.role },
                  { query: c.query, role: c.role }
                );
                render = t.render;
                intendedUsed.add(t.intended);
              }
              return {
                id: newId("clip"),
                start: c.start,
                end: c.end,
                score: c.score,
                reason: c.reason,
                label: c.label ?? sourceById.get(c.sourceId ?? "")?.meta.name,
                transition: render,
                confidence: c.confidence,
                sourceId: c.sourceId
              };
            });

            // Replace the timeline with the montage. setHighlights snapshots
            // the previous timeline, so "undo" restores it.
            setHighlights(finalClips);
            const firstSourceId = finalClips[0]?.sourceId;
            if (firstSourceId && firstSourceId !== composeStore.activeSourceId) {
              useEditorStore.getState().setActiveSource(firstSourceId);
            }
            // Honor the requested output format/duration at render time. Compose
            // otherwise lays clips without a plan, so "vertical" would be lost.
            if (compose.format || compose.userSpecifiedDuration) {
              setPlan(buildComposeOutputPlan(compose));
            }

            const runLabel = compose.outputTarget.name || "AI Combined 1";
            const total = finalClips.reduce(
              (acc, h) => acc + (h.end - h.start),
              0
            );
            const breakdown = perSource
              .filter((s) => s.count > 0)
              .map((s) => `${s.count} from \u201c${s.name}\u201d`)
              .join(", ");
            let summary = `Built ${runLabel} \u2014 a ${finalClips.length}-clip montage (${total.toFixed(1)}s): ${breakdown}. Tap \u201cRender\u201d to assemble. Say \u201cundo\u201d to restore your previous timeline.`;
            // Issue #64 — honest target reporting for all-source compose. If
            // the user asked for a minimum clip count or a duration we
            // couldn't reach, say so instead of implying success.
            if (
              compose.minClipCount &&
              finalClips.length < compose.minClipCount
            ) {
              summary += ` Heads up \u2014 you asked for at least ${compose.minClipCount} clips but I only found ${finalClips.length} with enough evidence across your videos.`;
            }
            if (
              compose.targetSeconds &&
              total < compose.targetSeconds * 0.7
            ) {
              summary += ` It runs ${total.toFixed(1)}s of your ${compose.targetSeconds}s target \u2014 some sources had weak material. Want me to broaden the selection?`;
            }
            // Honesty: if a non-renderable transition was requested, say
            // what actually got rendered.
            const fancy: ComposeTransitionType[] = [
              "glitch",
              "whip",
              "zoom",
              "match_cut"
            ];
            if (fancy.some((f) => intendedUsed.has(f))) {
              summary +=
                " (The editor renders cut, fade, and crossfade \u2014 I used the closest real transition for the fancier ones.)";
            }
            if (unresolved.length > 0) {
              summary += ` I couldn't match ${unresolved.length} of the videos you mentioned \u2014 check the library names.`;
            }
            pushMessage({ role: "assistant", content: summary });

            setStatus("ready", "Ready to render");
            setProgress(1);
            logSession.ai(
              "compose.applied",
              {
                runLabel,
                sourceCount: resolved.length,
                clipCount: finalClips.length,
                totalSeconds: round1(total),
                ordering: compose.ordering.type,
                anchorFirst: compose.ordering.anchorFirst ?? false,
                transition: compose.transition.type,
                perSource: perSource.map((s) => ({
                  sourceId: s.sourceId,
                  count: s.count
                })),
                unresolved: unresolved.length
              },
              `Composed ${finalClips.length} clip${finalClips.length === 1 ? "" : "s"} from ${resolved.length} source${resolved.length === 1 ? "" : "s"} (${total.toFixed(1)}s)`,
              Date.now() - t0
            );
          } catch (err) {
            const msg = friendlyStorageError(err) ?? (err as Error).message;
            pushMessage({
              role: "assistant",
              content: `Something went wrong while composing: ${msg}`
            });
            setStatus("failed", msg);
            logSession.system(
              "error.unhandled",
              { phase: "compose", message: msg },
              `Unhandled error: ${msg.slice(0, 80)}`
            );
          }
          return;
        }

        // ---- PROMOTE mode (v1.7.2) ----------------------------------------
        // The user asked us to use the briefing's identified moments as
        // actual timeline clips ("clip those", "use the second one",
        // "make a 30s reel of these"). No new vision call, no SigLIP
        // run — the briefing already pinned precise (start, end) for
        // each best part, so we just convert and merge.
        if (data.mode === "promote") {
          const storeState = useEditorStore.getState();
          const briefing = storeState.lastBriefing;
          if (!briefing || briefing.bestParts.length === 0) {
            pushMessage({
              role: "assistant",
              content:
                "I don't have a recent briefing in scope to clip from. Ask me to describe the video first."
            });
            setStatus(
              storeState.highlights.length > 0 ? "ready" : "idle",
              undefined
            );
            return;
          }
          if (data.inferred && data.inferred.length > 0) {
            setInferred(data.inferred);
          }
          const result = useEditorStore.getState().promoteBriefingParts({
            partIds: data.partIds,
            targetSeconds: data.targetSeconds,
            op: data.op ?? "append"
          });

          if (result.added === 0 && result.total === 0) {
            pushMessage({
              role: "assistant",
              content:
                "Couldn't promote any briefing parts \u2014 they may not match the requested ids."
            });
            setStatus(
              useEditorStore.getState().highlights.length > 0 ? "ready" : "idle",
              undefined
            );
            return;
          }

          const finalTimeline = useEditorStore.getState().highlights;
          const total = finalTimeline.reduce(
            (acc, h) => acc + (h.end - h.start),
            0
          );

          // Switch active source to the briefing's source so the
          // preview pane lines up with the new clips.
          if (
            briefing.sourceId &&
            briefing.sourceId !== useEditorStore.getState().activeSourceId
          ) {
            const sources = useEditorStore.getState().sources;
            if (sources.some((s) => s.id === briefing.sourceId)) {
              useEditorStore.getState().setActiveSource(briefing.sourceId);
            }
          }

          const skippedNote =
            result.skipped > 0
              ? ` (${result.skipped} skipped \u2014 overlap with existing clips)`
              : "";
          const opVerb = data.op === "replace" ? "Replaced" : "Added";
          pushMessage({
            role: "assistant",
            content:
              data.message ||
              `${opVerb} ${result.added} clip${result.added === 1 ? "" : "s"} from the briefing${skippedNote}. Timeline is now ${finalTimeline.length} clip${finalTimeline.length === 1 ? "" : "s"}, ${total.toFixed(1)}s total.`
          });

          setStatus("ready", undefined);
          setProgress(1);
          logSession.ai(
            "promote.applied",
            {
              briefingId: briefing.id,
              partsRequested:
                Array.isArray(data.partIds) && data.partIds.length > 0
                  ? data.partIds.length
                  : briefing.bestParts.length,
              added: result.added,
              skipped: result.skipped,
              total: result.total,
              op: data.op ?? "append",
              targetSeconds: data.targetSeconds
            },
            `Promoted ${result.added} briefing parts to the timeline`,
            plannerMs
          );
          return;
        }

        // ---- clarify mode -------------------------------------------------
        if (data.mode === "clarify") {
          setMode("clarify");
          setInferred([]);
          setPendingClarify({ message: data.message, questions: data.questions });
          setPendingExecution(false);
          // v1.6.2 — tag the message so the next agent turn's safety
          // net can identify it as a clarify even if the text wording
          // changes. Used by looksLikeClarify() in the agent route.
          pushMessage({
            role: "assistant",
            content: data.message,
            attachment: { mode: "clarify" }
          });
          setStatus("idle", "Awaiting answer");
          setProgress(0);
          logSession.ai(
            "mode.classified",
            { mode: "clarify", questions: data.questions.map((q) => q.id) },
            `Mode = clarify (${data.questions.length} question${data.questions.length === 1 ? "" : "s"})`,
            plannerMs
          );
          return;
        }

        // ---- plan / moment ------------------------------------------------
        let activePlan: EditPlan;
        if (data.planPatch && previousPlan) {
          const merged = applyPlanPatch(data.planPatch);
          if (!merged) {
            setPlan(data.plan);
            activePlan = data.plan;
          } else {
            activePlan = merged;
          }
          logSession.ai(
            "plan.refined",
            {
              changedFields: Object.keys(data.planPatch),
              targetShortSeconds: activePlan.targetShortSeconds
            },
            `Refined plan (${Object.keys(data.planPatch).join(", ")})`,
            plannerMs
          );
        } else {
          setPlan(data.plan);
          activePlan = data.plan;
          logSession.ai(
            "plan.created",
            {
              mode: data.mode,
              scenarios: activePlan.scenarios.map((s) => ({ id: s.id, prompt: s.prompt })),
              targetShortSeconds: activePlan.targetShortSeconds,
              format: activePlan.format,
              transition: activePlan.transition,
              selectionStrategy: activePlan.selectionStrategy,
              inferred: data.inferred,
              warnings: data.warnings
            },
            `Plan created: ${activePlan.userSpecifiedDuration ? `${activePlan.targetShortSeconds}s` : "flexible length"} ${activePlan.format} (${activePlan.scenarios.length} scenarios)`,
            plannerMs
          );
        }
        setMode(data.mode);
        setInferred(data.inferred ?? []);
        setPendingClarify(null);

        pushMessage({
          role: "assistant",
          content:
            data.message ||
            (data.mode === "moment" ? "Locating that moment." : "Plan ready.")
        });

        if (!videoBlob || !videoHash || !videoMeta) {
          setStatus(
            "idle",
            "Plan ready \u2014 upload a video to run the analysis."
          );
          setProgress(0);
          setPendingExecution(true);
          return;
        }

        // ---- Decide auto-run vs confirm ---------------------------------
        // Auto-run only when this is a refinement that reuses the cache.
        // Anything else (first plan, scenarios changed) shows the
        // PlanPreview card with a Run button to keep the UX honest about
        // when the expensive analysis fires.
        const cacheReusable =
          previousPlan !== null &&
          !scenariosChanged(previousPlan, activePlan) &&
          useEditorStore.getState().highlights.length > 0;

        // v1.7.1 — Append refinement. When the planner emits a
        // planPatch with scenariosOp = "append" AND the user already
        // has clips on the timeline, we run the pipeline ONLY for the
        // newly-added scenarios and append the results. Existing
        // clips are preserved by mergeHighlights inside runPipeline.
        // This is what makes "add the celebration too" stop wiping
        // out the curation from the previous turn.
        const isAppendRefinement =
          data.mode === "plan" &&
          !!data.planPatch &&
          data.planPatch.scenariosOp === "append" &&
          Array.isArray(data.planPatch.scenarios) &&
          data.planPatch.scenarios.length > 0 &&
          useEditorStore.getState().highlights.length > 0;

        // v1.7.9 — Decide how THIS run joins the timeline, and remember
        // it in the store so a deferred "Run analysis" tap (which calls
        // runPipeline with no opts) still appends/replaces correctly.
        //   - append refinement ("add the celebration") → append
        //   - cache-reusable refinement (same scenarios, e.g. "60s",
        //     "punchier") → replace, since we're re-selecting the SAME
        //     scenarios over cached scores, not adding a new topic
        //   - explicit planner op wins next
        //   - otherwise: append when the timeline already has clips
        //     (a new topic on top of an existing reel), replace when
        //     it's empty (the first plan of the session)
        const hasExistingClips =
          useEditorStore.getState().highlights.length > 0;
        let timelineOp: "append" | "replace";
        if (isAppendRefinement) timelineOp = "append";
        else if (cacheReusable) timelineOp = "replace";
        else if (data.op === "replace") timelineOp = "replace";
        else if (data.op === "append") timelineOp = "append";
        else timelineOp = hasExistingClips ? "append" : "replace";
        useEditorStore.getState().setPendingTimelineOp(timelineOp);

        if (isAppendRefinement) {
          setPendingExecution(false);
          const appendScenarioIds =
            data.planPatch?.scenarios?.map((s) => s.id) ?? [];
          await runPipeline("plan", { appendScenarioIds });
        } else if (cacheReusable) {
          setPendingExecution(false);
          await runPipeline(data.mode);
        } else if (data.autoRun) {
          // v1.9.x — The server flagged this as an actionable, direct-command
          // plan (a clear request like "ingredient part alone for 1min" or
          // "find funny moments") AND a video source exists, so we continue
          // straight into the analysis pipeline instead of waiting for a
          // "Run analysis" tap. The button still appears for non-actionable /
          // no-video plans (the branch below).
          setPendingExecution(false);
          await runPipeline(data.mode);
        } else {
          setPendingExecution(true);
          setStatus("ready", "Plan ready \u2014 tap Run analysis to start.");
          setProgress(0);
        }
      } catch (err) {
        const msg = friendlyStorageError(err) ?? (err as Error).message;
        pushMessage({
          role: "assistant",
          content: `Something went wrong: ${msg}`
        });
        setStatus("failed", msg);
        logSession.system(
          "error.unhandled",
          { phase: "agent", message: msg },
          `Unhandled error: ${msg.slice(0, 80)}`
        );
      } finally {
        setBusy(false);
      }
    },
    [
      videoBlob,
      videoMeta,
      videoHash,
      memory,
      pushMessage,
      setStatus,
      setProgress,
      setPlan,
      applyPlanPatch,
      setMode,
      setInferred,
      setPendingClarify,
      setPendingExecution,
      setUserTier,
      runPipeline,
      logSession
    ]
  );

  // ---- Confirm-and-run from the PlanPreview card --------------------------
  const handleRunPipeline = useCallback(async () => {
    const cur = useEditorStore.getState();
    if (!cur.plan) return;
    if (!videoBlob || !videoHash || !videoMeta) {
      pushMessage({
        role: "assistant",
        content: "Upload a video first, then I can run the analysis."
      });
      return;
    }
    setBusy(true);
    setPendingExecution(false);
    logUser({
      sessionId,
      kind: "plan.confirmed",
      payload: {
        targetShortSeconds: cur.plan.targetShortSeconds,
        format: cur.plan.format
      },
      summary: `Confirmed plan: ${cur.plan.targetShortSeconds}s ${cur.plan.format}`
    });
    try {
      await runPipeline(cur.mode === "moment" ? "moment" : "plan");
    } finally {
      setBusy(false);
    }
  }, [
    videoBlob,
    videoMeta,
    videoHash,
    sessionId,
    pushMessage,
    setPendingExecution,
    runPipeline
  ]);

  // v1.7.5 — Keep the ref pointing at the latest handleRunPipeline so
  // handleAgent's quick-shortcut gate (which is defined earlier in
  // the function body) can dispatch the right closure when an affirm
  // shortcut fires. This avoids reordering large blocks of code.
  useEffect(() => {
    handleRunPipelineRef.current = handleRunPipeline;
  }, [handleRunPipeline]);

  // ---- Structured briefing follow-up actions (Phase 5 — extracted) ------
  // The deterministic promote / plan_topic / extract_range logic now lives
  // in useBriefingActions (hooks/useBriefingActions.ts). Behavior is
  // identical; the page just supplies the store setters/loggers it owns.
  // `chat` follow-ups still route through the normal chat pipe in
  // AssistantPanel, not here.
  const handleBriefingAction = useBriefingActions({
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
  });

  // ---- Render -------------------------------------------------------------
  // v1.7.6 — Relaxed guards. The previous `!plan` check silently
  // aborted the click when a user reached the render path through one
  // of the newer non-planner intents (merge / promote / any client-
  // side quick-shortcut). Those paths put highlights on the timeline
  // without producing an EditPlan, so `plan` is null even though the
  // timeline is fully ready to render. We now require ONLY a non-empty
  // highlights list + at least one usable source. Format and transition
  // fall back to sensible defaults derived from the active source's
  // native aspect when no plan exists.
  const handleRender = useCallback(async () => {
    const cur = useEditorStore.getState();
    if (highlights.length === 0) return;
    // v2.1 — render guard: never invoke ffmpeg/mediabunny when a clip
    // references a source whose bytes aren't loaded (a restored project
    // awaiting re-upload). Surface an honest re-upload prompt instead.
    if (!cur.canRenderCurrentTimeline()) {
      const missing = cur.usedMissingSources();
      const names = missing.map((m) => m.meta.name).join(", ");
      pushMessage({
        role: "assistant",
        content:
          missing.length > 0
            ? `Re-upload the missing source ${missing.length === 1 ? "video" : "videos"} before rendering: ${names}.`
            : "Upload a video first, then I can render."
      });
      return;
    }
    const sources = cur.sources;
    if (sources.length === 0 && !videoBlob) {
      pushMessage({
        role: "assistant",
        content: "Upload a video first, then I can render."
      });
      return;
    }

    // Derive render parameters from the plan when available, otherwise
    // sensible defaults so paths like "just merge the videos" work.
    const format: "vertical" | "horizontal" | "square" = plan?.format ?? (() => {
      const meta = sources[0]?.meta ?? cur.videoMeta;
      if (!meta) return "horizontal";
      const aspect = meta.width / Math.max(1, meta.height);
      if (aspect < 0.85) return "vertical";
      if (aspect > 1.15) return "horizontal";
      return "square";
    })();
    const transition: "none" | "fade" | "crossfade" =
      plan?.transition ?? "none";
    const totalSeconds = highlights.reduce(
      (a, h) => a + (h.end - h.start),
      0
    );

    setBusy(true);
    setStatus("rendering", "Encoding short");
    setProgress(0);
    logSession.user(
      "render.requested",
      {
        clipCount: highlights.length,
        format,
        transition,
        totalSeconds,
        hasPlan: !!plan
      },
      `Render requested (${highlights.length} clips, ${format})`
    );
    const t0 = Date.now();
    try {
      // PR 59 — per-boundary renderable transitions (index 0 = lead-in).
      // Built from the store's auto/manual boundary transitions; falls back
      // to the global `transition` when none exist.
      const bts = cur.boundaryTransitions;
      const btByIndex = new Map(bts.map((b) => [b.index, b]));
      const boundaryRenders =
        bts.length > 0
          ? highlights.map((_, i) =>
              i === 0 ? "none" : btByIndex.get(i)?.render ?? "none"
            )
          : undefined;
      // v1.6.0 — pass the library + multi-source highlights. The hook
      // resolves which source blobs are actually needed (only those
      // referenced by highlights' `sourceId`), encodes them as `in0.mp4`,
      // `in1.mp4`, …, and remaps each clip's inputIndex so the filter
      // graph stitches across uploaded sources cleanly.
      const blob = await ffmpeg.render({
        sources: sources.length > 0 ? sources : undefined,
        videoBlob: sources.length === 0 ? videoBlob ?? undefined : undefined,
        highlights,
        format,
        transition,
        boundaryRenders,
        onProgress: (p) => setProgress(p)
      });
      setRendered(blob);
      setStatus("completed", "Short ready");
      setProgress(1);
      logSession.ai(
        "render.completed",
        {
          format,
          outputBytes: blob.size,
          clipCount: highlights.length
        },
        `Rendered ${(blob.size / 1024 / 1024).toFixed(1)}MB ${format}`,
        Date.now() - t0
      );
      pushMessage({
        role: "assistant",
        content: `Rendered ${(blob.size / 1024 / 1024).toFixed(1)}MB ${format} short.`
      });
    } catch (err) {
      const msg = friendlyStorageError(err) ?? (err as Error).message;
      pushMessage({
        role: "assistant",
        content: `Render failed: ${msg}`
      });
      setStatus("failed", msg);
      logSession.system(
        "error.unhandled",
        { phase: "render", message: msg },
        `Render failed: ${msg.slice(0, 80)}`
      );
    } finally {
      setBusy(false);
    }
  }, [
    videoBlob,
    plan,
    highlights,
    ffmpeg,
    setStatus,
    setProgress,
    setRendered,
    pushMessage,
    logSession
  ]);

  // Keep the render ref current so the agentic fast-command path
  // ("render" / "export") can trigger the real render.
  useEffect(() => {
    handleRenderRef.current = () => void handleRender();
  }, [handleRender]);

  const isRendering =
    busy && useEditorStore.getState().status === "rendering";

  return (
    <div className="editor-shell">
      {quota && quota.fraction >= 0.7 && (
        <QuotaBanner usage={quota.usage} limit={quota.limit} fraction={quota.fraction} />
      )}
      <Topbar
        onOpenActivity={() => setActivityDrawerOpen(true)}
        newActivityCount={unreadActivity}
        onOpenTranscript={() => setTranscriptDrawerOpen(true)}
        transcriptEnabled={cap.audioTier !== "off"}
      />
      <div className="studio">
        <ProjectRail />
        <EditorStage
          onOpenClips={() => setClipsDrawerOpen(true)}
          onRender={handleRender}
          isRendering={isRendering}
        />
        <AssistantPanel
          onSubmit={handleAgent}
          onOpenClips={() => setClipsDrawerOpen(true)}
          onRunPlan={handleRunPipeline}
          onBriefingAction={handleBriefingAction}
          isBusy={busy}
        />
      </div>
      <ClipsDrawer
        open={clipsDrawerOpen}
        onClose={() => setClipsDrawerOpen(false)}
      />
      <ActivityDrawer
        open={activityDrawerOpen}
        onClose={() => setActivityDrawerOpen(false)}
      />
      <TranscriptDrawer
        open={transcriptDrawerOpen}
        onClose={() => setTranscriptDrawerOpen(false)}
      />
    </div>
  );
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}


/** v1.6.0 — Render a chip value (string | number | bool | string[]) into a
 *  short single-line phrase the planner can read inside the library
 *  notes block. Caps at 80 chars to keep the prompt small. */
function formatChipValue(
  v: string | number | boolean | string[]
): string {
  if (Array.isArray(v)) return v.slice(0, 4).join(", ").slice(0, 80);
  return String(v).slice(0, 80);
}



/**
 * v1.6.4 — Sample a small set of evenly-spaced frames from a clip
 * range for the describe-clip vision call. We reuse the existing
 * mediabunny-based sampleFrames helper (the same one that drives the
 * scoring pipeline) and base64-encode each thumbnail for transport.
 *
 * targetCount=6 is a balance between the model getting enough temporal
 * context to answer "when does she enter the frame" and keeping the
 * payload small (six 256-wide JPEGs round-trip in ~200 KB). The
 * server endpoint caps at 8 either way.
 */
async function sampleClipForDescribe(args: {
  blob: Blob;
  startSeconds: number;
  endSeconds: number;
  targetCount: number;
}): Promise<Array<{ t: number; base64: string }>> {
  const { blob, startSeconds, endSeconds, targetCount } = args;
  const dur = Math.max(0.5, endSeconds - startSeconds);
  // Spread `targetCount` samples evenly across the range. The
  // sampleFrames util takes an `every` interval; we derive it.
  const every = Math.max(0.25, dur / Math.max(1, targetCount - 1));
  const { sampleFrames, blobToBase64 } = await import("@/lib/pipeline/sample");
  const frames = await sampleFrames(blob, {
    every,
    width: 384,
    range: { startSeconds, endSeconds },
    maxFrames: targetCount + 2
  });
  const sliced = frames.slice(0, targetCount);
  const out: Array<{ t: number; base64: string }> = [];
  for (const f of sliced) {
    out.push({ t: f.t, base64: await blobToBase64(f.blob) });
  }
  return out;
}

/** v1.6.4 — Render seconds as mm:ss for chat output. */
function formatT(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

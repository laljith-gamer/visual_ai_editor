"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Topbar } from "@/components/Topbar";
import { ProjectRail } from "@/components/ProjectRail";
import { EditorStage } from "@/components/EditorStage";
import { AssistantPanel } from "@/components/AssistantPanel";
import { ClipsDrawer } from "@/components/ClipsDrawer";
import { ActivityDrawer } from "@/components/ActivityDrawer";
import { QuotaBanner } from "@/components/QuotaBanner";
import { useEditorStore, scenariosChanged } from "@/hooks/useEditorStore";
import { useFFmpeg } from "@/hooks/useFFmpeg";
import { useCapability } from "@/hooks/useCapability";
import { useActivityLog } from "@/hooks/useActivityLog";
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
import { planSignaturePayload } from "@/lib/plan/normalize";
import {
  getPredictions,
  savePredictions,
  trimCache
} from "@/lib/store/cache";
import { sha1String } from "@/lib/util/hash";
import { logAi, logSystem, logUser } from "@/lib/log/recorders";
import { summarizeRecentActivity } from "@/lib/log/summarize";
import type {
  AgentRequest,
  AgentResponse,
  EditPlan,
  FrameScore,
  InferredField,
  IntentMode,
  VideoLibraryEntry
} from "@/lib/types";

interface QuotaWarning {
  usage: number;
  limit: number;
  fraction: number;
}

export default function Home() {
  const [clipsDrawerOpen, setClipsDrawerOpen] = useState(false);
  const [activityDrawerOpen, setActivityDrawerOpen] = useState(false);
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
  const messages = useEditorStore((s) => s.messages);

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

  // Persist when meaningful state transitions happen.
  useEffect(() => {
    void persist();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlights.length, plan?.scenarios.length, messages.length]);

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

  // -----------------------------------------------------------------------
  // v1.6.0 — Multi-source pipeline orchestrator.
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
    async (mode: IntentMode) => {
      const state = useEditorStore.getState();
      const activePlan = state.plan;
      if (!activePlan) return;
      if (mode !== "plan" && mode !== "moment") return;

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
          const msg =
            mode === "moment"
              ? "I couldn't lock onto that moment in any selected video. Try describing what would be on screen \u2014 colours, action, who's doing what."
              : `Nothing across the selected video${eligible.length === 1 ? "" : "s"} matched strongly enough (top score ${merged.scoreMax.toFixed(2)}). Try broader scenarios, or describe a single moment ("find the part where ___").`;
          pushMessage({ role: "assistant", content: msg });
          setStatus("ready", "No strong matches");
          setProgress(0);
          return;
        }

        setHighlights(merged.highlights);

        // Pick the active source to whatever the first kept clip points
        // at, so the preview pane plays the right footage immediately.
        const firstSourceId = merged.highlights[0]?.sourceId;
        if (firstSourceId && firstSourceId !== state.activeSourceId) {
          useEditorStore.getState().setActiveSource(firstSourceId);
        }

        const total = merged.highlights.reduce(
          (acc, h) => acc + (h.end - h.start),
          0
        );

        // Build a friendly summary that mentions the source breakdown
        // when the run was multi-source.
        let summary: string;
        if (eligible.length === 1) {
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
        }
        pushMessage({ role: "assistant", content: summary });

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
        const msg = (err as Error).message;
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
          memory,
          recentActivity: recentActivity || undefined
        };
        const t0 = Date.now();
        const planResp = await fetch("/api/agent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(reqBody)
        });
        const data = (await planResp.json().catch(() => ({}))) as AgentResponse;
        const plannerMs = Date.now() - t0;

        // ---- error mode ---------------------------------------------------
        if (!planResp.ok || data.mode === "error") {
          const msg =
            data.mode === "error" ? data.error : `Planner returned ${planResp.status}`;
          pushMessage({ role: "assistant", content: msg });
          setStatus("failed", msg);
          setProgress(0);
          if (planResp.status === 429 || planResp.status === 503) {
            logSession.system(
              "ratelimit.hit",
              {
                layer: "agent",
                status: planResp.status,
                retryAfterSeconds:
                  data.mode === "error" ? data.retryAfterSeconds : undefined
              },
              `Rate-limited (${planResp.status})`
            );
          }
          return;
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
          if (highlights.length === 0) {
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
          setHighlights(built);
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
            `Plan created: ${activePlan.targetShortSeconds}s ${activePlan.format} (${activePlan.scenarios.length} scenarios)`,
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

        if (cacheReusable) {
          setPendingExecution(false);
          await runPipeline(data.mode);
        } else {
          setPendingExecution(true);
          setStatus("ready", "Plan ready \u2014 tap Run analysis to start.");
          setProgress(0);
        }
      } catch (err) {
        const msg = (err as Error).message;
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

  // ---- Render -------------------------------------------------------------
  const handleRender = useCallback(async () => {
    if (!videoBlob || !plan || highlights.length === 0) return;
    setBusy(true);
    setStatus("rendering", "Encoding short");
    setProgress(0);
    logSession.user(
      "render.requested",
      {
        clipCount: highlights.length,
        format: plan.format,
        transition: plan.transition,
        totalSeconds: highlights.reduce((a, h) => a + (h.end - h.start), 0)
      },
      `Render requested (${highlights.length} clips, ${plan.format})`
    );
    const t0 = Date.now();
    try {
      // v1.6.0 — pass the library + multi-source highlights. The hook
      // resolves which source blobs are actually needed (only those
      // referenced by highlights' `sourceId`), encodes them as `in0.mp4`,
      // `in1.mp4`, …, and remaps each clip's inputIndex so the filter
      // graph stitches across uploaded sources cleanly.
      const sources = useEditorStore.getState().sources;
      const blob = await ffmpeg.render({
        sources: sources.length > 0 ? sources : undefined,
        videoBlob: sources.length === 0 ? videoBlob ?? undefined : undefined,
        highlights,
        format: plan.format,
        transition: plan.transition,
        onProgress: (p) => setProgress(p)
      });
      setRendered(blob);
      setStatus("completed", "Short ready");
      setProgress(1);
      logSession.ai(
        "render.completed",
        {
          format: plan.format,
          outputBytes: blob.size,
          clipCount: highlights.length
        },
        `Rendered ${(blob.size / 1024 / 1024).toFixed(1)}MB ${plan.format}`,
        Date.now() - t0
      );
      pushMessage({
        role: "assistant",
        content: `Rendered ${(blob.size / 1024 / 1024).toFixed(1)}MB ${plan.format} short.`
      });
    } catch (err) {
      const msg = (err as Error).message;
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

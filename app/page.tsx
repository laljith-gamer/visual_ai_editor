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
  IntentMode
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
  // Pipeline execution. Extracted so both handleAgent (refinement auto-run
  // path) and handleRunPipeline (PlanPreview confirm button) can call it.
  // Reads the *current* plan from the store, NOT a captured closure.
  // -----------------------------------------------------------------------
  const runPipeline = useCallback(
    async (mode: IntentMode) => {
      const activePlan = useEditorStore.getState().plan;
      if (!activePlan || !videoBlob || !videoHash || !videoMeta) return;
      const previousPlanForCacheKey = activePlan; // sig is computed against active

      try {
        const sig = await sha1String(planSignaturePayload(activePlan));
        const cached = await getPredictions(videoHash, sig);
        let frameScores: FrameScore[];

        if (cached) {
          logSession.system(
            "cache.hit",
            { signature: sig.slice(0, 12), frames: cached.frames.length },
            `Cache hit: reused ${cached.frames.length} frame scores`
          );
          frameScores = cached.frames;
          setStatus("scoring", "Reused cached predictions");
          setProgress(0.5);
        } else {
          logSession.system(
            "cache.miss",
            { signature: sig.slice(0, 12) },
            "Cache miss — fresh sample+score pass"
          );
          frameScores = await sampleAndScore(activePlan);
        }

        // v1.5.0: when the plan carries an extractRange, narrow the scored
        // frames to that range before selection. Cached frames cover the
        // full video, so this is a post-filter on cache hits and a
        // pre-filter on cache misses (sampleAndScore reads the range too).
        if (activePlan.extractRange) {
          const r = activePlan.extractRange;
          const start = r.kind === "last" ? Math.max(0, videoMeta.duration - (r.endSeconds - r.startSeconds)) : r.startSeconds;
          const end = r.kind === "last" ? videoMeta.duration : r.endSeconds;
          frameScores = frameScores.filter((f) => f.t >= start && f.t < end);
        }

        if (mode === "moment") {
          setStatus("temporal", "Finding the exact moment");
          setProgress(0.65);
          const t1 = Date.now();
          // v1.4.0: pass userTier through so moment-mode also gets the
          // novice force-min fallback. The store value was set from the
          // last agent response (or defaults to "novice").
          const momentTier = useEditorStore.getState().userTier;
          const buildResult = await buildMomentHighlight({
            videoBlob,
            frameScores,
            plan: activePlan,
            videoDuration: videoMeta.duration,
            userTier: momentTier,
            videoMeta,
            onProgress: (done, total) =>
              setProgress(0.65 + (done / Math.max(total, 1)) * 0.3)
          });
          const built = buildResult.highlights;
          if (built.length === 0) {
            pushMessage({
              role: "assistant",
              content:
                "I couldn't lock onto that moment. Try describing what you'd actually see on screen \u2014 colours, action, who or what is doing what."
            });
            setStatus("ready", "No moment found");
            setProgress(0);
            logSession.ai(
              "moment.localized",
              { found: false, userTier: momentTier },
              "Moment not found"
            );
            return;
          }
          setHighlights(built);
          if (buildResult.weakOnly) {
            pushMessage({
              role: "assistant",
              content: `Picked the closest match I could find (${(built[0].end - built[0].start).toFixed(1)}s) \u2014 confidence is on the low side. Reword the moment for a tighter pick.`
            });
          } else {
            pushMessage({
              role: "assistant",
              content: `Found it. Picked a ${(built[0].end - built[0].start).toFixed(1)}s clip.`
            });
          }
          setStatus("ready", "Ready to render");
          setProgress(1);
          logSession.ai(
            "moment.localized",
            {
              found: true,
              start: built[0].start,
              end: built[0].end,
              score: built[0].score,
              weakOnly: buildResult.weakOnly,
              userTier: momentTier
            },
            `Moment localized: ${built[0].start.toFixed(1)}s \u2192 ${built[0].end.toFixed(1)}s${buildResult.weakOnly ? " (low confidence)" : ""}`,
            Date.now() - t1
          );
          return;
        }

        // PLAN mode — multi-clip pipeline.
        setStatus("temporal", "Finding event windows");
        setProgress(0.62);

        // v1.4.0: tier comes straight from the LLM via the store (no
        // server- or client-side regex). The detector and the highlights
        // builder use this to widen / narrow selection adaptively.
        const userTier = useEditorStore.getState().userTier;

        const detectionResult = detectCandidateWindows(
          frameScores,
          activePlan,
          { userTier, videoMeta }
        );
        const candidates = detectionResult.windows;
        const scoreStats = detectionResult.stats;
        logSession.ai(
          "events.detected",
          {
            candidateCount: candidates.length,
            framesScored: frameScores.length,
            userTier,
            percentile: detectionResult.percentile,
            cutoff: round2(detectionResult.cutoff),
            scoreMax: round2(scoreStats.max),
            scoreMean: round2(scoreStats.mean)
          },
          `${candidates.length} candidate window${candidates.length === 1 ? "" : "s"} from ${frameScores.length} frames (tier=${userTier}, top ${(detectionResult.percentile * 100).toFixed(0)}%)`
        );

        if (candidates.length === 0) {
          pushMessage({
            role: "assistant",
            content:
              "I couldn't read frames from the video. Re-upload it and try again."
          });
          setStatus("ready", "No candidates");
          setProgress(0);
          return;
        }

        const t2 = Date.now();
        const verdicts = await runTemporalPass({
          videoBlob,
          candidates,
          plan: activePlan,
          onProgress: (done, total) =>
            setProgress(0.65 + (done / Math.max(total, 1)) * 0.25)
        });
        for (const v of verdicts) {
          logSession.ai(
            "temporal.verdict",
            { start: v.start, end: v.end, keepScore: v.keepScore, reason: v.reason },
            `${v.start.toFixed(1)}s\u2013${v.end.toFixed(1)}s keep=${v.keepScore.toFixed(2)} (${v.reason})`
          );
        }

        setStatus("selecting", "Picking the final clips");
        setProgress(0.92);
        const buildResult = buildHighlights({
          candidates,
          verdicts,
          plan: activePlan,
          videoDuration: videoMeta.duration,
          userTier,
          scoreStats
        });
        const built = buildResult.highlights;
        setHighlights(built);
        const totalSel = built.reduce((acc, h) => acc + (h.end - h.start), 0);
        logSession.ai(
          "highlights.built",
          {
            count: built.length,
            totalSeconds: round1(totalSel),
            selectionStrategy: activePlan.selectionStrategy,
            weakOnly: buildResult.weakOnly,
            consideredCount: buildResult.consideredCount,
            userTier
          },
          `Built ${built.length} clip${built.length === 1 ? "" : "s"} (${totalSel.toFixed(1)}s total${buildResult.weakOnly ? ", low confidence" : ""})`,
          Date.now() - t2
        );

        if (built.length === 0) {
          // Only happens for advanced tier with no usable matches OR
          // a pathological zero-frame scoring run. Be honest, but keep
          // the copy human.
          pushMessage({
            role: "assistant",
            content: `Nothing in this video matched strongly enough (top frame score ${scoreStats.max.toFixed(2)}). Try broader scenarios, or describe a single moment ("find the part where ___").`
          });
          setStatus("ready", "No strong matches");
          setProgress(0);
          return;
        }

        if (buildResult.weakOnly) {
          pushMessage({
            role: "assistant",
            content: `Picked ${built.length} clip${built.length === 1 ? "" : "s"} but match confidence is on the low side (top score ${scoreStats.max.toFixed(2)}). Try broader scenarios for stronger picks.`
          });
        } else {
          pushMessage({
            role: "assistant",
            content: `Picked ${built.length} clip${built.length === 1 ? "" : "s"} totalling ${totalSel.toFixed(1)}s. Tap "Render" to assemble the short.`
          });
        }
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

      // -- inner helper to keep both cache-hit/miss branches DRY -----
      async function sampleAndScore(p: EditPlan): Promise<FrameScore[]> {
        if (!videoBlob || !videoHash) {
          throw new Error("video blob disappeared");
        }
        setStatus("sampling", "Extracting frames");
        const tA = Date.now();
        // v1.5.0: pass the plan's extractRange so we don't decode frames
        // outside the user-asked range. Saves ~80% of work on a 10-min
        // source when the prompt was "first 1 min".
        const range = p.extractRange
          ? p.extractRange.kind === "last"
            ? {
                startSeconds: Math.max(
                  0,
                  (videoMeta?.duration ?? 0) -
                    (p.extractRange.endSeconds - p.extractRange.startSeconds)
                ),
                endSeconds: videoMeta?.duration ?? 0
              }
            : {
                startSeconds: p.extractRange.startSeconds,
                endSeconds: p.extractRange.endSeconds
              }
          : undefined;
        const frames = await sampleFrames(videoBlob, {
          every: p.sampleEverySeconds,
          width: p.inferenceWidth,
          range,
          onProgress: (pp) => setProgress(0.05 + pp * 0.2)
        });
        logSession.ai(
          "frames.sampled",
          { count: frames.length, everySeconds: p.sampleEverySeconds, widthPx: p.inferenceWidth },
          `Sampled ${frames.length} frames every ${p.sampleEverySeconds}s @${p.inferenceWidth}px`,
          Date.now() - tA
        );

        setStatus("scoring", `Scoring ${frames.length} frames (${cap.tier})`);
        const tier = cap.tier === "low" ? "cloud" : "siglip-local";
        const tB = Date.now();
        const scored = await scoreFrames({
          frames,
          plan: p,
          tier,
          onProgress: (done, total) =>
            setProgress(0.25 + (done / total) * 0.35)
        });
        logSession.ai(
          "frames.scored",
          { count: scored.length, tier, cacheHit: false },
          `Scored ${scored.length} frames via ${tier}`,
          Date.now() - tB
        );
        await savePredictions({
          videoHash,
          scenarioSignature: await sha1String(planSignaturePayload(p)),
          sampleEverySeconds: p.sampleEverySeconds,
          frames: scored,
          createdAt: Date.now()
        });
        await trimCache();
        return scored;
      }
      // Keep typescript happy about the captured closures.
      void previousPlanForCacheKey;
    },
    [
      videoBlob,
      videoMeta,
      videoHash,
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
          pushMessage({ role: "assistant", content: data.message });
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
      const blob = await ffmpeg.render({
        videoBlob,
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

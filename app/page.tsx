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
  FrameScore
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

  // ---- Submit a chat turn -------------------------------------------------
  const handleAgent = useCallback(
    async (userRequest: string) => {
      setBusy(true);
      pushMessage({ role: "user", content: userRequest });
      const previousPlan = useEditorStore.getState().plan;

      try {
        setStatus("planning", "Talking to the planner");
        setProgress(0.05);

        // Build the conversation history (everything currently in store + the
        // turn we just appended) and send to the agent route.
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
            data.mode === "error"
              ? data.error
              : `Planner returned ${planResp.status}`;
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

        // ---- Soft-tier quota banner --------------------------------------
        if (data.mode !== "clarify" && "quotaWarning" in data && data.quotaWarning) {
          setQuota(data.quotaWarning);
        } else if (data.mode === "clarify" && data.quotaWarning) {
          setQuota(data.quotaWarning);
        }

        // ---- clarify mode -------------------------------------------------
        if (data.mode === "clarify") {
          setMode("clarify");
          setInferred([]);
          setPendingClarify({
            message: data.message,
            questions: data.questions
          });
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
          return;
        }

        // ---- Decide whether the predictions cache is reusable ------------
        const reusable = !scenariosChanged(previousPlan, activePlan);
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
        } else if (reusable) {
          logSession.system(
            "cache.miss",
            { signature: sig.slice(0, 12), reason: "scenarios_unchanged" },
            "Cache miss but scenarios match — single sample+score pass"
          );
          frameScores = await sampleAndScore(activePlan);
        } else {
          logSession.system(
            "cache.miss",
            { signature: sig.slice(0, 12), reason: "scenarios_changed" },
            "Scenarios changed — fresh sample+score pass"
          );
          frameScores = await sampleAndScore(activePlan);
        }

        // ---- Branch on mode for selection ---------------------------------
        if (data.mode === "moment") {
          setStatus("temporal", "Finding the exact moment");
          setProgress(0.65);
          const t1 = Date.now();
          const built = await buildMomentHighlight({
            videoBlob,
            frameScores,
            plan: activePlan,
            videoDuration: videoMeta.duration,
            onProgress: (done, total) =>
              setProgress(0.65 + (done / Math.max(total, 1)) * 0.3)
          });
          if (built.length === 0) {
            pushMessage({
              role: "assistant",
              content:
                "I couldn't find a strong match for that moment. Try rewording it (e.g., describe what you'd see in the frame)."
            });
            setStatus("ready", "No moment found");
            setProgress(0);
            logSession.ai(
              "moment.localized",
              { found: false },
              "Moment not found"
            );
            return;
          }
          setHighlights(built);
          pushMessage({
            role: "assistant",
            content: `Found it. Picked a ${(built[0].end - built[0].start).toFixed(1)}s clip.`
          });
          setStatus("ready", "Ready to render");
          setProgress(1);
          logSession.ai(
            "moment.localized",
            {
              found: true,
              start: built[0].start,
              end: built[0].end,
              score: built[0].score
            },
            `Moment localized: ${built[0].start.toFixed(1)}s → ${built[0].end.toFixed(1)}s`,
            Date.now() - t1
          );
          return;
        }

        // PLAN mode → multi-clip pipeline.
        setStatus("temporal", "Finding event windows");
        setProgress(0.62);
        const candidates = detectCandidateWindows(frameScores, activePlan);
        logSession.ai(
          "events.detected",
          {
            candidateCount: candidates.length,
            framesScored: frameScores.length
          },
          `${candidates.length} candidate window${candidates.length === 1 ? "" : "s"} from ${frameScores.length} frames`
        );

        if (candidates.length === 0) {
          pushMessage({
            role: "assistant",
            content:
              "I couldn't find any windows that strongly match. Try loosening the wording or adding scenarios."
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
        const built = buildHighlights({
          candidates,
          verdicts,
          plan: activePlan,
          videoDuration: videoMeta.duration
        });
        setHighlights(built);
        const totalSel = built.reduce((acc, h) => acc + (h.end - h.start), 0);
        logSession.ai(
          "highlights.built",
          {
            count: built.length,
            totalSeconds: round1(totalSel),
            selectionStrategy: activePlan.selectionStrategy
          },
          `Built ${built.length} clip${built.length === 1 ? "" : "s"} (${totalSel.toFixed(1)}s total)`,
          Date.now() - t2
        );
        pushMessage({
          role: "assistant",
          content: `Picked ${built.length} clip${built.length === 1 ? "" : "s"} totalling ${totalSel.toFixed(1)}s. Tap "Render" to assemble the short.`
        });
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
          { message: msg },
          `Unhandled error: ${msg.slice(0, 80)}`
        );
      } finally {
        setBusy(false);
      }

      // -- inner helper to keep both cache-miss branches DRY -----
      async function sampleAndScore(p: EditPlan): Promise<FrameScore[]> {
        if (!videoBlob || !videoHash) {
          throw new Error("video blob disappeared");
        }
        setStatus("sampling", "Extracting frames");
        const tA = Date.now();
        const frames = await sampleFrames(videoBlob, {
          every: p.sampleEverySeconds,
          width: p.inferenceWidth,
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
    },
    [
      videoBlob,
      videoMeta,
      videoHash,
      memory,
      cap.tier,
      pushMessage,
      setStatus,
      setProgress,
      setPlan,
      applyPlanPatch,
      setHighlights,
      setMode,
      setInferred,
      setPendingClarify,
      logSession
    ]
  );

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

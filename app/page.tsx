"use client";

import { useCallback, useEffect, useState } from "react";
import { Topbar } from "@/components/Topbar";
import { ProjectRail } from "@/components/ProjectRail";
import { EditorStage } from "@/components/EditorStage";
import { AssistantPanel } from "@/components/AssistantPanel";
import { ClipsDrawer } from "@/components/ClipsDrawer";
import { useEditorStore, scenariosChanged } from "@/hooks/useEditorStore";
import { useFFmpeg } from "@/hooks/useFFmpeg";
import { useCapability } from "@/hooks/useCapability";
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
import type {
  AgentRequest,
  AgentResponse,
  EditPlan,
  FrameScore
} from "@/lib/types";

export default function Home() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ffmpeg = useFFmpeg();
  const cap = useCapability();

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

  // Persist when meaningful state transitions happen.
  useEffect(() => {
    void persist();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlights.length, plan?.scenarios.length, messages.length]);

  // ---- Submit a chat turn -------------------------------------------------
  const handleAgent = useCallback(
    async (userRequest: string) => {
      setBusy(true);
      const userMsg = pushMessage({ role: "user", content: userRequest });
      const previousPlan = useEditorStore.getState().plan;

      try {
        setStatus("planning", "Talking to the planner");
        setProgress(0.05);

        // Build the conversation history (everything currently in store + the
        // turn we just appended) and send to the agent route.
        const history = [...useEditorStore.getState().messages];
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
          memory
        };
        const planResp = await fetch("/api/agent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(reqBody)
        });

        const data = (await planResp.json().catch(() => ({}))) as AgentResponse;

        // ---- error mode ---------------------------------------------------
        if (!planResp.ok || data.mode === "error") {
          const msg =
            data.mode === "error"
              ? data.error
              : `Planner returned ${planResp.status}`;
          pushMessage({ role: "assistant", content: msg });
          setStatus("failed", msg);
          setProgress(0);
          return;
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
          return;
        }

        // ---- plan / moment ------------------------------------------------
        // Apply the new plan. If the response had a planPatch and we have a
        // current plan, we MERGE; otherwise we replace.
        let activePlan: EditPlan;
        if (data.planPatch && previousPlan) {
          const merged = applyPlanPatch(data.planPatch);
          if (!merged) {
            // Defensive: shouldn't happen because previousPlan is non-null
            setPlan(data.plan);
            activePlan = data.plan;
          } else {
            activePlan = merged;
          }
        } else {
          setPlan(data.plan);
          activePlan = data.plan;
        }
        setMode(data.mode);
        setInferred(data.inferred ?? []);
        setPendingClarify(null);

        // Friendly assistant reply.
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

        if (cached || reusable) {
          if (cached) {
            frameScores = cached.frames;
            setStatus("scoring", "Reused cached predictions");
            setProgress(0.5);
          } else {
            // Same scenarios but cache miss (e.g., first turn after upload):
            // we still need to sample + score this once.
            const frames = await sampleFrames(videoBlob, {
              every: activePlan.sampleEverySeconds,
              width: activePlan.inferenceWidth,
              onProgress: (p) => setProgress(0.05 + p * 0.2)
            });
            setStatus(
              "scoring",
              `Scoring ${frames.length} frames (${cap.tier})`
            );
            const tier = cap.tier === "low" ? "cloud" : "siglip-local";
            frameScores = await scoreFrames({
              frames,
              plan: activePlan,
              tier,
              onProgress: (done, total) =>
                setProgress(0.25 + (done / total) * 0.35)
            });
            await savePredictions({
              videoHash,
              scenarioSignature: sig,
              sampleEverySeconds: activePlan.sampleEverySeconds,
              frames: frameScores,
              createdAt: Date.now()
            });
            await trimCache();
          }
        } else {
          // Scenarios changed: full pipeline.
          setStatus("sampling", "Extracting frames");
          const frames = await sampleFrames(videoBlob, {
            every: activePlan.sampleEverySeconds,
            width: activePlan.inferenceWidth,
            onProgress: (p) => setProgress(0.05 + p * 0.2)
          });
          setStatus(
            "scoring",
            `Scoring ${frames.length} frames (${cap.tier})`
          );
          const tier = cap.tier === "low" ? "cloud" : "siglip-local";
          frameScores = await scoreFrames({
            frames,
            plan: activePlan,
            tier,
            onProgress: (done, total) =>
              setProgress(0.25 + (done / total) * 0.35)
          });
          await savePredictions({
            videoHash,
            scenarioSignature: sig,
            sampleEverySeconds: activePlan.sampleEverySeconds,
            frames: frameScores,
            createdAt: Date.now()
          });
          await trimCache();
        }

        // ---- Branch on mode for selection ---------------------------------
        if (data.mode === "moment") {
          setStatus("temporal", "Finding the exact moment");
          setProgress(0.65);
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
            return;
          }
          setHighlights(built);
          pushMessage({
            role: "assistant",
            content: `Found it. Picked a ${(built[0].end - built[0].start).toFixed(1)}s clip.`
          });
          setStatus("ready", "Ready to render");
          setProgress(1);
          return;
        }

        // PLAN mode → multi-clip pipeline.
        setStatus("temporal", "Finding event windows");
        setProgress(0.62);
        const candidates = detectCandidateWindows(frameScores, activePlan);
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
        const verdicts = await runTemporalPass({
          videoBlob,
          candidates,
          plan: activePlan,
          onProgress: (done, total) =>
            setProgress(0.65 + (done / Math.max(total, 1)) * 0.25)
        });

        setStatus("selecting", "Picking the final clips");
        setProgress(0.92);
        const built = buildHighlights({
          candidates,
          verdicts,
          plan: activePlan,
          videoDuration: videoMeta.duration
        });
        setHighlights(built);
        pushMessage({
          role: "assistant",
          content: `Picked ${built.length} clip${built.length === 1 ? "" : "s"} totalling ${built
            .reduce((acc, h) => acc + (h.end - h.start), 0)
            .toFixed(1)}s. Tap "Render" to assemble the short.`
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
      } finally {
        // Best-effort: if we never got past planning, keep the user message.
        void userMsg;
        setBusy(false);
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
      setPendingClarify
    ]
  );

  // ---- Render -------------------------------------------------------------
  const handleRender = useCallback(async () => {
    if (!videoBlob || !plan || highlights.length === 0) return;
    setBusy(true);
    setStatus("rendering", "Encoding short");
    setProgress(0);
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
    pushMessage
  ]);

  const isRendering =
    busy && useEditorStore.getState().status === "rendering";

  return (
    <div className="editor-shell">
      <Topbar />
      <div className="studio">
        <ProjectRail />
        <EditorStage
          onOpenClips={() => setDrawerOpen(true)}
          onRender={handleRender}
          isRendering={isRendering}
        />
        <AssistantPanel
          onSubmit={handleAgent}
          onOpenClips={() => setDrawerOpen(true)}
          isBusy={busy}
        />
      </div>
      <ClipsDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </div>
  );
}

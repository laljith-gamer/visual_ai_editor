"use client";

import { useCallback, useEffect, useState } from "react";
import { Topbar } from "@/components/Topbar";
import { ProjectRail } from "@/components/ProjectRail";
import { EditorStage } from "@/components/EditorStage";
import { AssistantPanel } from "@/components/AssistantPanel";
import { ClipsDrawer } from "@/components/ClipsDrawer";
import { useEditorStore } from "@/hooks/useEditorStore";
import { useFFmpeg } from "@/hooks/useFFmpeg";
import { useCapability } from "@/hooks/useCapability";
import { sampleFrames } from "@/lib/pipeline/sample";
import { scoreFrames } from "@/lib/pipeline/score";
import { detectCandidateWindows } from "@/lib/pipeline/events";
import { runTemporalPass } from "@/lib/pipeline/temporal";
import { buildHighlights } from "@/lib/pipeline/highlights";
import { normalizePlan, planSignaturePayload } from "@/lib/plan/normalize";
import {
  getPredictions,
  savePredictions,
  trimCache
} from "@/lib/store/cache";
import { sha1String } from "@/lib/util/hash";
import type { EditPlan, FrameScore } from "@/lib/types";

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

  const pushMessage = useEditorStore((s) => s.pushMessage);
  const setStatus = useEditorStore((s) => s.setStatus);
  const setProgress = useEditorStore((s) => s.setProgress);
  const setPlan = useEditorStore((s) => s.setPlan);
  const setHighlights = useEditorStore((s) => s.setHighlights);
  const setRendered = useEditorStore((s) => s.setRendered);
  const persist = useEditorStore((s) => s.persist);

  // Persist on important state transitions.
  useEffect(() => {
    void persist();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlights.length, plan?.scenarios.length]);

  const handleAgent = useCallback(
    async (userRequest: string) => {
      setBusy(true);
      pushMessage({ role: "user", content: userRequest });

      try {
        // 1) Plan
        setStatus("planning", "Talking to the planner");
        setProgress(0.05);
        const planResp = await fetch("/api/agent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            userRequest,
            videoDurationSeconds: videoMeta?.duration,
            memory
          })
        });
        if (!planResp.ok) {
          const err = await planResp.json().catch(() => ({}));
          throw new Error(err.error ?? `Planner returned ${planResp.status}`);
        }
        const planJson = (await planResp.json()) as { plan: unknown };
        const newPlan = normalizePlan(planJson.plan);
        setPlan(newPlan);
        pushMessage({
          role: "assistant",
          content: planSummary(newPlan)
        });

        if (!videoBlob || !videoHash || !videoMeta) {
          setStatus("idle", "Plan ready — upload a video to run the analysis.");
          setProgress(0);
          return;
        }

        // 2) Predictions cache
        const sig = await sha1String(planSignaturePayload(newPlan));
        const cached = await getPredictions(videoHash, sig);
        let frameScores: FrameScore[];

        if (cached) {
          frameScores = cached.frames;
          setStatus("scoring", "Reused cached predictions");
          setProgress(0.5);
        } else {
          // 3) Sample
          setStatus("sampling", "Extracting frames");
          const frames = await sampleFrames(videoBlob, {
            every: newPlan.sampleEverySeconds,
            width: newPlan.inferenceWidth,
            onProgress: (p) => setProgress(0.05 + p * 0.2)
          });

          // 4) Score
          setStatus("scoring", `Scoring ${frames.length} frames (${cap.tier})`);
          const tier = cap.tier === "low" ? "cloud" : "siglip-local";
          frameScores = await scoreFrames({
            frames,
            plan: newPlan,
            tier,
            onProgress: (done, total) =>
              setProgress(0.25 + (done / total) * 0.35)
          });
          await savePredictions({
            videoHash,
            scenarioSignature: sig,
            sampleEverySeconds: newPlan.sampleEverySeconds,
            frames: frameScores,
            createdAt: Date.now()
          });
          await trimCache(50);
        }

        // 5) Detect candidate windows
        setStatus("temporal", "Finding event windows");
        setProgress(0.62);
        const candidates = detectCandidateWindows(frameScores, newPlan);

        if (candidates.length === 0) {
          pushMessage({
            role: "assistant",
            content:
              "I couldn't find any windows that strongly match your prompt. Try loosening the wording or adding scenarios."
          });
          setStatus("ready", "No candidates");
          setProgress(0);
          return;
        }

        // 6) Temporal pass
        const verdicts = await runTemporalPass({
          videoBlob,
          candidates,
          plan: newPlan,
          onProgress: (done, total) =>
            setProgress(0.65 + (done / Math.max(total, 1)) * 0.25)
        });

        // 7) Build highlights
        setStatus("selecting", "Picking the final clips");
        setProgress(0.92);
        const built = buildHighlights({
          candidates,
          verdicts,
          plan: newPlan,
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
        setBusy(false);
      }
    },
    [videoBlob, videoMeta, videoHash, memory, cap.tier, pushMessage, setStatus, setProgress, setPlan, setHighlights]
  );

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
  }, [videoBlob, plan, highlights, ffmpeg, setStatus, setProgress, setRendered, pushMessage]);

  return (
    <div className="editor-shell">
      <Topbar />
      <div className="studio">
        <ProjectRail />
        <EditorStage
          onOpenClips={() => setDrawerOpen(true)}
          onRender={handleRender}
          isRendering={busy && useEditorStore.getState().status === "rendering"}
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

function planSummary(p: EditPlan): string {
  const lines: string[] = [];
  lines.push(
    `Plan: ${p.targetShortSeconds}s ${p.format} short, ${p.transition} transitions, ${p.selectionStrategy} selection.`
  );
  lines.push(
    `Looking for: ${p.scenarios.map((s) => s.prompt).join(", ")}.`
  );
  if (p.avoid.length) lines.push(`Avoiding: ${p.avoid.join(", ")}.`);
  if (p.rationale) lines.push(`Why: ${p.rationale}`);
  return lines.join("\n");
}

"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, Sparkles } from "lucide-react";
import { ProgressRing } from "@/components/launch/ProgressRing";
import {
  StepChecklist,
  type ChecklistStep
} from "@/components/launch/StepChecklist";
import { FrameStrip } from "@/components/launch/FrameStrip";
import { useEditorStore } from "@/hooks/useEditorStore";
import {
  consumePendingUpload,
  peekPendingUpload
} from "@/lib/util/uploadHandoff";
import { probeVideo, sampleFrames } from "@/lib/pipeline/sample";
import { sha256Blob } from "@/lib/util/hash";
import { friendlyStorageError } from "@/lib/store/idb";
import styles from "./launch.module.css";

/** How many preview thumbnails the FrameStrip shows. */
const PREVIEW_FRAMES = 8;
/** Width per preview thumbnail (px). Small — we want ~60-80 KB total. */
const PREVIEW_WIDTH = 160;

/** Step IDs match what the user sees, top-to-bottom. */
const STEP_IDS = ["read", "probe", "sample", "hash", "ready"] as const;
type StepId = (typeof STEP_IDS)[number];

interface StepDef {
  id: StepId;
  label: string;
  /** Cumulative progress fraction at which this step completes. */
  endAt: number;
}

/** The progress weights below were tuned by hand against typical
 *  inputs (2-min 1080p clip on a mid-tier laptop). They're indicative
 *  not authoritative — the real work drives the bar via the
 *  per-stage callbacks. The endAt values just clamp the smoothing
 *  target so a fast probe doesn't snap the ring forward and freak
 *  out the user. */
const STEPS: StepDef[] = [
  { id: "read",   label: "Reading file",        endAt: 0.05 },
  { id: "probe",  label: "Probing video",       endAt: 0.15 },
  { id: "sample", label: "Capturing preview frames", endAt: 0.6 },
  { id: "hash",   label: "Hashing for cache",   endAt: 0.95 },
  { id: "ready",  label: "Ready",               endAt: 1.0 }
];

/**
 * /launch — the cinematic transition between picking a video on the
 * home page and landing in the editor. Orchestrates real work
 * (probe → sample → hash → addSource) while showing visible progress.
 *
 * Direct navigation guard: if there's no pending file in the handoff
 * slot the user shouldn't be here, so we bounce back to /. Refreshing
 * during the launch sequence also bounces home rather than re-running
 * a stale operation.
 */
export default function LaunchPage() {
  const router = useRouter();
  // Capture the file synchronously on first render so React strict-mode
  // double-mounts in dev don't lose it. The actual `consume` happens
  // inside the effect (clears the slot so refresh doesn't replay).
  const [file] = useState<File | null>(() => peekPendingUpload());
  const addSource = useEditorStore((s) => s.addSource);

  // Visible state: smoothed progress, current step, frame thumbs, error.
  const [progress, setProgress] = useState(0);
  const [steps, setSteps] = useState<ChecklistStep[]>(() =>
    STEPS.map((s) => ({ id: s.id, label: s.label, status: "pending" as const }))
  );
  const [frameUrls, setFrameUrls] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Hold rAF + cleanup so we can cancel on unmount.
  const rafRef = useRef<number | null>(null);
  const targetRef = useRef(0);
  const valueRef = useRef(0);
  const framesAddedRef = useRef<string[]>([]);

  // ---- Smoothed progress ticker ----------------------------------------
  // Real work emits target values in jumps; we ease-in toward the target
  // every animation frame so the ring counts up like a real download
  // bar instead of stuttering. The smoothing is a simple exponential.
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const t = targetRef.current;
      const v = valueRef.current;
      const next = v + (t - v) * 0.12;
      const clamped = Math.abs(t - next) < 0.0008 ? t : next;
      valueRef.current = clamped;
      setProgress(clamped);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Convenience helpers used inside the pipeline.
  function setTarget(p: number) {
    targetRef.current = Math.max(targetRef.current, Math.min(1, p));
  }
  function markStep(id: StepId, status: ChecklistStep["status"], detail?: string) {
    setSteps((prev) =>
      prev.map((s) => (s.id === id ? { ...s, status, detail } : s))
    );
  }

  // ---- Main pipeline ---------------------------------------------------
  useEffect(() => {
    if (!file) {
      // Direct nav / refresh — nothing to process, send them home.
      router.replace("/");
      return;
    }

    // Single-use the handoff slot: if a refresh happens later, peek
    // returns null and the guard above catches it.
    consumePendingUpload();

    let cancelled = false;
    const cleanupUrls: string[] = [];

    async function run() {
      try {
        // ---- 1. Read file (instant, but we hold for 250 ms so the
        //         step UI has a moment to register) -------------------
        markStep("read", "active");
        setTarget(0.04);
        await delay(220);
        markStep("read", "done", `${(file!.size / 1024 / 1024).toFixed(1)} MB`);
        setTarget(0.05);

        if (cancelled) return;

        // ---- 2. Probe (mediabunny, fast on most inputs) -------------
        markStep("probe", "active");
        const probe = await probeVideo(file!);
        markStep(
          "probe",
          "done",
          `${probe.width}x${probe.height} - ${formatDuration(probe.duration)}`
        );
        setTarget(0.15);

        if (cancelled) return;

        // ---- 3. Sample preview frames -------------------------------
        // We pick PREVIEW_FRAMES evenly-spaced thumbnails by setting
        // `every` so the strip looks like a real timeline scrub.
        // sampleFrames emits onProgress (0..1) which we map into our
        // 0.15 → 0.6 slot.
        markStep("sample", "active");
        const every = Math.max(0.5, probe.duration / PREVIEW_FRAMES);
        await sampleFrames(file!, {
          every,
          width: PREVIEW_WIDTH,
          maxFrames: PREVIEW_FRAMES,
          onProgress: (p) => {
            setTarget(0.15 + p * 0.45);
          }
        }).then(async (frames) => {
          // Convert each Blob to an object URL and feed the strip.
          // We do this inside the sample then() so cancellation
          // doesn't try to access the closed-over `frames` array.
          for (const f of frames) {
            if (cancelled) return;
            const url = URL.createObjectURL(f.blob);
            cleanupUrls.push(url);
            framesAddedRef.current.push(url);
            setFrameUrls([...framesAddedRef.current]);
            // Tiny stagger so each frame perceptibly lands.
            await delay(30);
          }
        });
        markStep(
          "sample",
          "done",
          `${framesAddedRef.current.length} frames`
        );
        setTarget(0.6);

        if (cancelled) return;

        // ---- 4. Hash (sha256, single-shot) --------------------------
        // crypto.subtle.digest doesn't expose progress. We start a
        // fake-but-bounded ramp from 0.6 → 0.92 timed against the
        // file size, then snap to 0.95 the moment the digest resolves.
        markStep("hash", "active");
        const fakeRamp = startFakeRamp({
          from: 0.6,
          to: 0.92,
          // Rough heuristic: 200ms per 100MB, min 600ms, max 4s.
          durationMs: clamp(
            ((file!.size / (100 * 1024 * 1024)) * 200) + 600,
            600,
            4000
          ),
          setTarget
        });
        const hash = await sha256Blob(file!);
        fakeRamp.cancel();
        markStep("hash", "done", hash.slice(0, 8) + "...");
        setTarget(0.95);

        if (cancelled) return;

        // ---- 5. Add to library + ready ------------------------------
        markStep("ready", "active");
        const added = addSource(
          file!,
          {
            name: file!.name,
            size: file!.size,
            duration: probe.duration,
            width: probe.width,
            height: probe.height
          },
          hash
        );
        if (!added) {
          throw new Error(
            "Library is full. Open the editor and remove a video first."
          );
        }
        setTarget(1);
        markStep("ready", "done", added.meta.name);

        // v1.7.3 — Kick off background transcription. Fire-and-forget:
        // we don't block the navigation to /editor on this. Whisper's
        // first run downloads ~40 MB of weights which can take 10s+
        // on a cold connection; the user shouldn't wait for that.
        // The launch page has already finished its visible work, so
        // hijacking it for a long-running ASR call would feel wrong.
        // The editor page picks up the transcript via useTranscription
        // when it lands.
        try {
          const { transcribe } = await import("@/lib/audio/transcribe");
          const cap = await import("@/hooks/useCapability");
          // We can't call useCapability() outside React, so probe the
          // env directly here. The hook's logic is duplicated minimally;
          // see useCapability.detectAudioTier for the canonical version.
          void cap; // keep import for tree-shaking honesty
          const hasWebGPU = "gpu" in navigator;
          const hasSAB = typeof SharedArrayBuffer !== "undefined";
          const memGB =
            (navigator as Navigator & { deviceMemory?: number }).deviceMemory ??
            8;
          const cores = navigator.hardwareConcurrency ?? 8;
          const audioTier: "high" | "mid" | "low" =
            hasWebGPU && memGB >= 6
              ? "high"
              : hasSAB && cores >= 4
                ? "mid"
                : "low";
          // Don't await; the editor page surfaces progress via the
          // useTranscription hook once mounted.
          void transcribe({
            blob: file!,
            sourceHash: hash,
            sourceId: added.id,
            audioTier,
            hasWebGPU
          }).catch(() => {
            // Swallow errors — the user is about to land in the
            // editor, where the drawer's "Re-transcribe" affordance
            // surfaces a friendlier retry.
          });
        } catch {
          /* ignore — transcription is non-critical to launch */
        }

        // Brief celebratory hold before the wipe, so the user sees the
        // ring actually finish at 100% rather than insta-cutting.
        await delay(380);
        if (cancelled) return;
        setDone(true);

        // Wipe duration matches the CSS animation in launch.module.css.
        await delay(620);
        if (cancelled) return;
        router.replace("/editor");
      } catch (err) {
        if (cancelled) return;
        const msg =
          friendlyStorageError(err) ||
          (err as Error).message ||
          "Something went wrong.";
        setError(msg);
        // Mark whichever step is currently active as errored.
        setSteps((prev) =>
          prev.map((s) => (s.status === "active" ? { ...s, status: "error" } : s))
        );
      }
    }

    void run();
    return () => {
      cancelled = true;
      // Object URLs for the preview frames are short-lived. We hold
      // them for the duration of the launch screen so the strip can
      // render, and revoke them all on unmount (right before the
      // editor mounts) so we don't leak.
      for (const u of cleanupUrls) URL.revokeObjectURL(u);
    };
    // We deliberately don't depend on addSource/router — both are
    // stable identities and re-running this effect would replay the
    // pipeline which we already gate via consumePendingUpload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  // ---- Render ---------------------------------------------------------

  if (error) {
    return (
      <main className={styles.shell}>
        <div className={styles.errorBox}>
          <span className={styles.errorIcon}>
            <AlertTriangle size={20} />
          </span>
          <h2 className={styles.errorTitle}>Couldn&apos;t prepare your video</h2>
          <p className={styles.errorBody}>{error}</p>
          <div className={styles.errorActions}>
            <button
              className={styles.errorPrimary}
              onClick={() => router.replace("/")}
            >
              <ArrowLeft size={14} /> Try another file
            </button>
            <button
              className={styles.errorSecondary}
              onClick={() => router.replace("/editor")}
            >
              Open editor anyway
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className={`${styles.shell} ${done ? styles.wiping : ""}`}>
      {/* Animated mesh background — same vocabulary as the home page
          so the transition feels like the same product. */}
      <div className={styles.bg} aria-hidden />

      <header className={styles.header}>
        <span className={styles.brandIcon} aria-hidden>
          <Sparkles size={12} />
        </span>
        <span className={styles.brandText}>Shorts Studio</span>
      </header>

      <div className={styles.stage}>
        <ProgressRing
          value={progress}
          label={
            done ? "Opening editor" : steps.find((s) => s.status === "active")?.label ?? "Preparing"
          }
          detail={file?.name}
          done={done}
        />

        <div className={styles.checklistCol}>
          <StepChecklist steps={steps} />
        </div>
      </div>

      <div className={styles.stripWrap}>
        <FrameStrip slots={PREVIEW_FRAMES} frames={frameUrls} />
      </div>

      {/* Full-screen wipe panel — slides up from below at the end of
          the sequence, masking the navigation away. */}
      <div className={styles.wipe} aria-hidden />
    </main>
  );
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "?";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Drives the progress ring from `from` toward `to` over `durationMs`
 *  using an ease-out curve. Used for steps where the underlying
 *  primitive (crypto.subtle.digest) doesn't emit progress. The caller
 *  invokes cancel() the moment real progress lands so we don't fight
 *  with the smoother. */
function startFakeRamp(args: {
  from: number;
  to: number;
  durationMs: number;
  setTarget: (n: number) => void;
}) {
  const { from, to, durationMs, setTarget } = args;
  const start = performance.now();
  let stopped = false;
  function step() {
    if (stopped) return;
    const t = Math.min(1, (performance.now() - start) / durationMs);
    // Ease-out cubic so it slows as it approaches `to`, leaving
    // headroom for the real digest to snap us forward.
    const eased = 1 - Math.pow(1 - t, 3);
    setTarget(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
  return {
    cancel() {
      stopped = true;
    }
  };
}

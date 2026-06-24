import type { EditPlan, FrameScore, SignalWeights } from "@/lib/types";
import type { SampledFrame } from "@/lib/pipeline/sample";
import { blobToBase64 } from "@/lib/pipeline/sample";
import { aggregateFrameScore } from "@/lib/vision/score-local";
import { CLOUD_FRAME, SIGNAL_DEFAULTS } from "@/lib/config";
import { composite, motionOnlyScores, isCloudResultUsable } from "@/lib/pipeline/scoreFallback";

interface ScoreArgs {
  frames: SampledFrame[];
  plan: EditPlan;
  tier: "siglip-local" | "cloud";
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /** Fires once the on-device scorer reports which backend loaded
   *  ("webgpu" | "wasm"), so the UI can honestly say it's running on CPU. */
  onBackend?: (device: string) => void;
}

/**
 * Per-frame scoring orchestrator. v1.5.0 routes by signal weights:
 *
 *   - if plan.signals.semantic > 0 AND scenarios.length > 0 → run SigLIP
 *     (locally or via the cloud fallback) for the semantic score.
 *   - if plan.signals.semantic === 0 OR scenarios is empty → skip SigLIP
 *     entirely. The composite score falls back to motion + saliency only,
 *     which is enough to rank "best part" / "interesting bits" queries
 *     without paying the SigLIP cost.
 *
 * The composite score that drives selection is:
 *   score = w_sem · semantic + w_mot · motion + w_sal · saliency
 *
 * Each component is already 0..1; weights normalize so the result is too.
 * All knobs in lib/config.ts → SIGNAL_DEFAULTS.
 */
export async function scoreFrames({
  frames,
  plan,
  tier,
  signal,
  onProgress,
  onBackend
}: ScoreArgs): Promise<FrameScore[]> {
  const weights = resolveSignalWeights(plan);
  // Run SigLIP when the composite uses semantic OR when a constraint graph
  // references scenarios that must be measured. The latter covers the case of
  // an exclude (or include) on an otherwise motion/saliency "best parts" plan:
  // we must still SEE the excluded/required concept to gate on it. Without
  // this, "best parts but avoid the intro" would skip SigLIP and silently
  // ignore the exclusion.
  const constraintNeedsScoring =
    !!plan.constraints &&
    (plan.constraints.include.some((c) => c.scenarioIds.length > 0) ||
      plan.constraints.exclude.some((c) => c.scenarioIds.length > 0));
  const needsSemantic =
    (weights.semantic > 0 || constraintNeedsScoring) && plan.scenarios.length > 0;

  if (!needsSemantic) {
    // Visual-interest-only path: motion + saliency from sampling, no model.
    return motionOnlyScores(frames, weights);
  }

  const composeArgs: ComposeArgs = { frames, plan, weights, signal, onProgress, onBackend };

  // DEGRADE LADDER (never silently "guess"):
  //   cloud (if selected) → on-device SigLIP (WebGPU or CPU/wasm) → motion.
  if (tier === "cloud") {
    const cloud = await scoreCloudWithCompose(composeArgs);
    if (isCloudResultUsable(cloud)) return cloud;
    // Cloud unconfigured / unreachable (e.g. 503) → don't fall straight to the
    // motion guess: try to UNDERSTAND on-device first. Only if that also fails
    // do we use motion as the true last resort.
    return scoreLocalOrMotion(composeArgs);
  }
  return scoreLocalOrMotion(composeArgs);
}

/** On-device semantic scoring, with motion/saliency as the true last resort
 *  (when no vision backend — WebGPU nor CPU/wasm — could load). */
async function scoreLocalOrMotion(args: ComposeArgs): Promise<FrameScore[]> {
  try {
    return await scoreLocalWithCompose(args);
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    // No on-device model could run at all → motion + saliency only. This is
    // the one path that surfaces "visual AI unavailable" downstream.
    return motionOnlyScores(args.frames, args.weights);
  }
}

/** True when the cloud frame pass returned at least one real per-label score.
 *  An all-empty result means the cloud route was unconfigured/blocked (503),
 *  so the caller should fall back to on-device understanding.
 *  (Implemented in scoreFallback.ts; re-exported there.) */

let workerSingleton: Worker | null = null;

function getWorker(): Worker {
  if (workerSingleton) return workerSingleton;
  workerSingleton = new Worker(
    new URL("../vision/siglip.worker.ts", import.meta.url),
    { type: "module" }
  );
  return workerSingleton;
}

interface ComposeArgs {
  frames: SampledFrame[];
  plan: EditPlan;
  weights: SignalWeights;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  onBackend?: (device: string) => void;
}

async function scoreLocalWithCompose({
  frames,
  plan,
  weights,
  signal,
  onProgress,
  onBackend
}: ComposeArgs): Promise<FrameScore[]> {
  const worker = getWorker();
  const out: FrameScore[] = [];

  const init = await postToWorker<{ ready: boolean; device: string } | boolean>(worker, {
    type: "init",
    labels: plan.scenarios.map((s) => s.prompt),
    ids: plan.scenarios.map((s) => s.id)
  });
  // The worker reports which backend actually loaded (webgpu | wasm) so the UI
  // can be honest about a slower CPU run.
  if (init && typeof init === "object" && typeof init.device === "string") {
    onBackend?.(init.device);
  }

  for (let i = 0; i < frames.length; i++) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const f = frames[i];
    const labels = await postToWorker<Record<string, number>>(worker, {
      type: "score",
      blob: f.blob,
      t: f.t
    });
    const semantic = aggregateFrameScore(labels, plan);
    out.push({
      t: f.t,
      labels,
      semantic,
      motion: f.motion,
      saliency: f.saliency,
      focusX: f.focusX,
      focusY: f.focusY,
      score: composite(semantic, f.motion, f.saliency, weights)
    });
    onProgress?.(i + 1, frames.length);
  }
  return out;
}

async function scoreCloudWithCompose({
  frames,
  plan,
  weights,
  signal,
  onProgress
}: ComposeArgs): Promise<FrameScore[]> {
  // Cloud path: batch frames to /api/vision/frame to stay within Gemini RPM.
  const cloudResults: Array<{ t: number; labels: Record<string, number> }> = [];
  const batchSize = CLOUD_FRAME.batchSize;
  for (let i = 0; i < frames.length; i += batchSize) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const batch = frames.slice(i, i + batchSize);
    const payload = await Promise.all(
      batch.map(async (f) => ({
        t: f.t,
        imageBase64: await blobToBase64(f.blob)
      }))
    );
    const resp = await fetch("/api/vision/frame", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        frames: payload,
        scenarios: plan.scenarios.map((s) => ({ id: s.id, prompt: s.prompt }))
      }),
      signal
    });
    if (!resp.ok) {
      for (const f of batch) cloudResults.push({ t: f.t, labels: {} });
    } else {
      const json = (await resp.json()) as {
        results: Array<{ t: number; labels: Record<string, number> }>;
      };
      cloudResults.push(...(json.results ?? []));
    }
    onProgress?.(Math.min(i + batchSize, frames.length), frames.length);
  }
  // Match cloud results back to sampled frames so we keep motion + saliency.
  const semanticByT = new Map<number, Record<string, number>>();
  for (const r of cloudResults) semanticByT.set(round2(r.t), r.labels);
  return frames.map<FrameScore>((f) => {
    const labels = semanticByT.get(round2(f.t)) ?? {};
    const semantic = aggregateFrameScore(labels, plan);
    return {
      t: f.t,
      labels,
      semantic,
      motion: f.motion,
      saliency: f.saliency,
      focusX: f.focusX,
      focusY: f.focusY,
      score: composite(semantic, f.motion, f.saliency, weights)
    };
  });
}

// ---------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------

function resolveSignalWeights(plan: EditPlan): SignalWeights {
  if (plan.signals) {
    const w = plan.signals;
    const sum = w.semantic + w.motion + w.saliency;
    if (sum > 0) {
      return {
        semantic: w.semantic / sum,
        motion: w.motion / sum,
        saliency: w.saliency / sum
      };
    }
  }
  // Fallback: pick a profile based on whether scenarios are concrete.
  if (plan.scenarios.length === 0) return SIGNAL_DEFAULTS.visualInterest;
  return SIGNAL_DEFAULTS.scenarioHeavy;
}

interface WorkerRequest {
  type: "init" | "score";
  blob?: Blob;
  t?: number;
  labels?: string[];
  ids?: string[];
}

function postToWorker<T = unknown>(worker: Worker, msg: WorkerRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const onMsg = (e: MessageEvent) => {
      if (e.data?.id !== id) return;
      worker.removeEventListener("message", onMsg);
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data.payload as T);
    };
    worker.addEventListener("message", onMsg);
    worker.postMessage({ ...msg, id });
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

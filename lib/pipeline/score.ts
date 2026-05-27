import type { EditPlan, FrameScore } from "@/lib/types";
import type { SampledFrame } from "@/lib/pipeline/sample";
import { blobToBase64 } from "@/lib/pipeline/sample";
import { aggregateFrameScore, toFrameScores } from "@/lib/vision/score-local";
import { CLOUD_FRAME } from "@/lib/config";

interface ScoreArgs {
  frames: SampledFrame[];
  plan: EditPlan;
  tier: "siglip-local" | "cloud";
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Per-frame scoring orchestrator. Routes to the local SigLIP worker or to
 * the cloud fallback Route Handler based on the chosen tier. All knobs in
 * lib/config.ts.
 */
export async function scoreFrames({
  frames,
  plan,
  tier,
  signal,
  onProgress
}: ScoreArgs): Promise<FrameScore[]> {
  if (tier === "siglip-local") {
    return scoreLocal({ frames, plan, signal, onProgress });
  }
  return scoreCloud({ frames, plan, signal, onProgress });
}

let workerSingleton: Worker | null = null;

function getWorker(): Worker {
  if (workerSingleton) return workerSingleton;
  workerSingleton = new Worker(
    new URL("../vision/siglip.worker.ts", import.meta.url),
    { type: "module" }
  );
  return workerSingleton;
}

async function scoreLocal({
  frames,
  plan,
  signal,
  onProgress
}: Omit<ScoreArgs, "tier">): Promise<FrameScore[]> {
  const worker = getWorker();
  const out: FrameScore[] = [];

  await postToWorker(worker, {
    type: "init",
    labels: plan.scenarios.map((s) => s.prompt),
    ids: plan.scenarios.map((s) => s.id)
  });

  for (let i = 0; i < frames.length; i++) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const f = frames[i];
    const labels = await postToWorker<Record<string, number>>(worker, {
      type: "score",
      blob: f.blob,
      t: f.t
    });
    out.push({ t: f.t, labels, score: aggregateFrameScore(labels, plan) });
    onProgress?.(i + 1, frames.length);
  }
  return out;
}

async function scoreCloud({
  frames,
  plan,
  signal,
  onProgress
}: Omit<ScoreArgs, "tier">): Promise<FrameScore[]> {
  // Cloud path: batch frames to /api/vision/frame to stay within Gemini RPM.
  const out: Array<{ t: number; labels: Record<string, number> }> = [];
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
      for (const f of batch) out.push({ t: f.t, labels: {} });
    } else {
      const json = (await resp.json()) as {
        results: Array<{ t: number; labels: Record<string, number> }>;
      };
      out.push(...(json.results ?? []));
    }
    onProgress?.(Math.min(i + batchSize, frames.length), frames.length);
  }
  return toFrameScores(out, plan);
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

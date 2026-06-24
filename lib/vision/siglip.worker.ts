/// <reference lib="webworker" />
/**
 * SigLIP zero-shot classification worker.
 *
 * Loads `Xenova/siglip-base-patch16-224` once via @huggingface/transformers,
 * then for each frame computes per-label cosine similarities (softmax-like
 * normalized) against the user-provided text labels.
 *
 * Communication protocol:
 *   { id, type: "init", labels: string[], ids: string[] }
 *   { id, type: "score", blob: Blob, t: number }
 *
 * Reply:
 *   { id, payload?: ..., error?: string }
 */
import { pipeline, env } from "@huggingface/transformers";
import { VISION } from "../config";

env.allowLocalModels = false;
env.useBrowserCache = true;

interface InitMessage {
  id: string;
  type: "init";
  labels: string[];
  ids: string[];
}
interface ScoreMessage {
  id: string;
  type: "score";
  blob: Blob;
  t: number;
}
type Incoming = InitMessage | ScoreMessage;

type PipeOptions = { device: string; dtype: string };

let classifier: ((
  image: Blob,
  labels: string[]
) => Promise<Array<{ label: string; score: number }>>) | null = null;
/** Which backend actually loaded ("webgpu" | "wasm"). Reported back on init so
 *  the UI can honestly say "analyzing on CPU (slower)" vs GPU. */
let activeDevice: string | null = null;
let scenarioLabels: string[] = [];
let scenarioIds: string[] = [];
/** Precomputed label -> id lookup, built once per init. Keeps first-match
 *  semantics identical to the previous `scenarioLabels.indexOf(label)`. */
let labelToId = new Map<string, string>();

/** True when this worker can reach a WebGPU adapter. WASM is always available
 *  as the CPU fallback, so visual understanding runs even without a GPU. */
function workerHasWebGPU(): boolean {
  try {
    return typeof navigator !== "undefined" && "gpu" in navigator && Boolean(navigator.gpu);
  } catch {
    return false;
  }
}

async function ensureClassifier() {
  if (classifier) return;
  // Build the load ladder: WebGPU first when available, then CPU/wasm so a
  // GPU-less device still UNDERSTANDS frames instead of guessing from motion.
  const plan: PipeOptions[] = [
    ...(workerHasWebGPU() ? (VISION.devicePlan.webgpu as readonly PipeOptions[]) : []),
    ...(VISION.devicePlan.cpu as readonly PipeOptions[])
  ];
  let lastErr: unknown = null;
  for (const opt of plan) {
    try {
      const pipe = (await pipeline(
        "zero-shot-image-classification",
        VISION.model,
        opt as unknown as Parameters<typeof pipeline>[2]
      )) as unknown as (
        image: Blob,
        labels: string[]
      ) => Promise<Array<{ label: string; score: number }>>;
      classifier = pipe;
      activeDevice = opt.device;
      return;
    } catch (err) {
      // This device/precision combo isn't available here (no WebGPU, missing
      // quantized weights, OOM, …) — try the next rung of the ladder.
      lastErr = err;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("No vision backend could be loaded");
}

self.onmessage = async (e: MessageEvent<Incoming>) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      scenarioLabels = msg.labels;
      scenarioIds = msg.ids;
      labelToId = new Map<string, string>();
      for (let i = 0; i < scenarioLabels.length; i++) {
        // Only set on first occurrence to mirror indexOf's first-match.
        if (!labelToId.has(scenarioLabels[i])) {
          labelToId.set(scenarioLabels[i], scenarioIds[i]);
        }
      }
      await ensureClassifier();
      (self as unknown as Worker).postMessage({
        id: msg.id,
        payload: { ready: true, device: activeDevice }
      });
      return;
    }
    if (msg.type === "score") {
      await ensureClassifier();
      const results = await classifier!(msg.blob, scenarioLabels);
      const labels: Record<string, number> = {};
      for (const r of results) {
        const id = labelToId.get(r.label);
        if (id !== undefined) labels[id] = r.score;
      }
      (self as unknown as Worker).postMessage({ id: msg.id, payload: labels });
      return;
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: msg.id,
      error: (err as Error).message
    });
  }
};

export {};
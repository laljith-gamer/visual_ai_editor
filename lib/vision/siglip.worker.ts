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

let classifier: ((
  image: Blob,
  labels: string[]
) => Promise<Array<{ label: string; score: number }>>) | null = null;
let scenarioLabels: string[] = [];
let scenarioIds: string[] = [];

async function ensureClassifier() {
  if (classifier) return;
  const pipe = (await pipeline(
    "zero-shot-image-classification",
    "Xenova/siglip-base-patch16-224",
    // device: "webgpu" auto-falls back to wasm if WebGPU is unavailable
    { device: "webgpu" } as Parameters<typeof pipeline>[2]
  )) as unknown as (
    image: Blob,
    labels: string[]
  ) => Promise<Array<{ label: string; score: number }>>;
  classifier = pipe;
}

self.onmessage = async (e: MessageEvent<Incoming>) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      scenarioLabels = msg.labels;
      scenarioIds = msg.ids;
      await ensureClassifier();
      (self as unknown as Worker).postMessage({ id: msg.id, payload: true });
      return;
    }
    if (msg.type === "score") {
      await ensureClassifier();
      const results = await classifier!(msg.blob, scenarioLabels);
      const labels: Record<string, number> = {};
      for (const r of results) {
        const idx = scenarioLabels.indexOf(r.label);
        if (idx >= 0) labels[scenarioIds[idx]] = r.score;
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

// =====================================================================
// lib/vision/caption.ts
//
// Main-thread orchestrator for the OPTIONAL in-browser frame captioner.
//
// Responsibilities:
//   - Decide IF captioning should run at all (capability gate + flag).
//   - Pick the model for the device tier (mirrors AUDIO/SigLIP tiers).
//   - Drive the caption.worker over a STRIDED subset of frames.
//   - Degrade gracefully: any failure → return frames unchanged (no
//     captions). Captioning is a semantic BONUS, never a hard dependency.
//
// The output is the SAME frame objects with an added `caption` on the
// captioned subset — directly consumable by buildFrameTree (which treats
// caption as optional) and by VISION-EDIT-CORE.
//
// This module performs NO network calls itself; the worker downloads the
// model weights from the HF CDN (already allowed by the CSP connect-src).
// =====================================================================

import { CAPTION } from "@/lib/config";
import type { CapabilityTier } from "@/lib/types";

/** Minimal frame shape the captioner needs. Structurally satisfied by
 *  SampledFrame (which also has width/height/motion/saliency). */
export interface CaptionableFrame {
  t: number;
  blob: Blob;
  caption?: string;
}

export interface CaptionOptions {
  /** Device tier from useCapability(). Drives model selection. */
  tier: CapabilityTier;
  /** Master switch. When false, captioning is skipped entirely and the
   *  input frames are returned unchanged. Callers wire this to a user
   *  setting and/or the capability gate. Default false (opt-in). */
  enabled?: boolean;
  /** Caption every Nth frame. Defaults to CAPTION.captionStride. */
  stride?: number;
  /** Hard cap on captioned frames. Defaults to CAPTION.maxCaptionedFrames. */
  maxCaptioned?: number;
  /** Progress callback (capioned, totalToCaption). */
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface CaptionResult<F extends CaptionableFrame> {
  /** Input frames, with `caption` populated on the strided subset. */
  frames: F[];
  /** How many frames actually received a caption. */
  captionedCount: number;
  /** True when captioning ran; false when skipped or fully degraded. */
  ran: boolean;
  /** Machine-readable note when skipped/degraded ("disabled",
   *  "unsupported", "load_failed", "aborted", ""). */
  note: string;
}

/** Is captioning even possible on this device? WebGPU strongly preferred;
 *  we allow it on any tier that earns "high" or "mid" (mid runs the
 *  lightweight ViT-GPT2 model, which is WASM-tolerant). */
export function isCaptioningSupported(tier: CapabilityTier): boolean {
  if (typeof Worker === "undefined") return false;
  return tier === "high" || tier === "mid";
}

/** Select the model repo for a tier. */
export function captionModelForTier(tier: CapabilityTier): string {
  switch (tier) {
    case "high":
      return CAPTION.modelHigh;
    case "mid":
      return CAPTION.modelMid;
    default:
      return CAPTION.modelLow;
  }
}

// ---------------------------------------------------------------------
// Worker singleton (mirrors score.ts getWorker pattern)
// ---------------------------------------------------------------------

let workerSingleton: Worker | null = null;
let workerModel: string | null = null;

function getWorker(model: string): Worker {
  // Recreate if the model changed (tier switch between sources).
  if (workerSingleton && workerModel === model) return workerSingleton;
  if (workerSingleton) {
    workerSingleton.terminate();
    workerSingleton = null;
  }
  workerSingleton = new Worker(
    new URL("./caption.worker.ts", import.meta.url),
    { type: "module" }
  );
  workerModel = model;
  return workerSingleton;
}

/** Tear down the captioner worker (e.g. on session reset) to free the
 *  model from memory. Safe to call when nothing is running. */
export function disposeCaptioner(): void {
  if (workerSingleton) {
    workerSingleton.terminate();
    workerSingleton = null;
    workerModel = null;
  }
}

// ---------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------

/**
 * Caption a strided subset of frames. Returns the SAME frame objects with
 * `caption` filled on the subset. Never throws — on any problem it returns
 * the input unchanged with a `note` explaining why.
 */
export async function captionFrames<F extends CaptionableFrame>(
  frames: F[],
  options: CaptionOptions
): Promise<CaptionResult<F>> {
  const isTestMode = typeof window !== 'undefined' && window.localStorage.getItem('DISABLE_WEBLLM') === '1';
  if (isTestMode) {
    console.log("TEST MODE: Mocking captionFrames");
    frames.forEach(f => f.caption = "Test mock caption");
    return { frames, captionedCount: frames.length, ran: true, note: "TEST_MOCK" };
  }

  const enabled = options.enabled ?? false;
  if (!enabled) {
    return { frames, captionedCount: 0, ran: false, note: "disabled" };
  }
  if (!isCaptioningSupported(options.tier) || frames.length === 0) {
    return { frames, captionedCount: 0, ran: false, note: "unsupported" };
  }

  const stride = Math.max(1, Math.round(options.stride ?? CAPTION.captionStride));
  const maxCaptioned = Math.max(
    1,
    Math.round(options.maxCaptioned ?? CAPTION.maxCaptionedFrames)
  );
  const model = captionModelForTier(options.tier);
  const isFlorence = /florence/i.test(model);

  // Indices to caption: every `stride`-th frame, capped.
  const targets: number[] = [];
  for (let i = 0; i < frames.length; i += stride) {
    targets.push(i);
    if (targets.length >= maxCaptioned) break;
  }
  if (targets.length === 0) {
    return { frames, captionedCount: 0, ran: false, note: "unsupported" };
  }

  let worker: Worker;
  try {
    worker = getWorker(model);
    await postToWorker(worker, {
      type: "init",
      model,
      ...(isFlorence ? { task: CAPTION.florenceTask } : {}),
      maxNewTokens: CAPTION.maxNewTokens
    });
  } catch {
    // Model failed to load (download blocked, no WebGPU, OOM). Degrade.
    disposeCaptioner();
    return { frames, captionedCount: 0, ran: false, note: "load_failed" };
  }

  let captionedCount = 0;
  for (let k = 0; k < targets.length; k++) {
    if (options.signal?.aborted) {
      return {
        frames,
        captionedCount,
        ran: captionedCount > 0,
        note: "aborted"
      };
    }
    const idx = targets[k];
    const f = frames[idx];
    try {
      const payload = await postToWorker<{ t: number; caption: string }>(
        worker,
        { type: "caption", blob: f.blob, t: f.t }
      );
      if (payload?.caption) {
        // Mutate a shallow copy to keep the array's frame objects stable
        // for callers that hold references by index.
        frames[idx] = { ...f, caption: payload.caption };
        captionedCount++;
      }
    } catch {
      // Per-frame failure is non-fatal; skip and keep going.
    }
    options.onProgress?.(k + 1, targets.length);
  }

  return {
    frames,
    captionedCount,
    ran: captionedCount > 0,
    note: captionedCount > 0 ? "" : "load_failed"
  };
}

// ---------------------------------------------------------------------
// Worker RPC (mirrors score.ts postToWorker)
// ---------------------------------------------------------------------

interface WorkerRequest {
  type: "init" | "caption";
  model?: string;
  task?: string;
  maxNewTokens?: number;
  blob?: Blob;
  t?: number;
}

function postToWorker<T = unknown>(
  worker: Worker,
  msg: WorkerRequest
): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = `${msg.type}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
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

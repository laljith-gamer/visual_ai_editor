/// <reference lib="webworker" />
/**
 * v1.7.3 — Whisper ASR worker.
 *
 * Mirrors the architecture of lib/vision/siglip.worker.ts so the
 * codebase has one consistent worker pattern:
 *   1. The main thread sends `init` with a model id; we lazy-load
 *      via @huggingface/transformers (already a dep) and reply when
 *      ready.
 *   2. The main thread sends `transcribe` with a Float32 PCM buffer
 *      (16 kHz mono) and we run the pipeline; replies stream
 *      progress events and end with a `result`.
 *
 * The pipeline call uses chunk_length_s=30 + stride_length_s=5 which
 * is the canonical Whisper long-form recipe — chunks stride into each
 * other so word boundaries don't get cut. Timestamps are returned per
 * segment, which we forward to the caller verbatim.
 *
 * We deliberately don't expose any settings beyond model id + device.
 * Adding a richer config (language hint, beam size, etc.) is easy
 * later but every knob is a way to go wrong on a first ship.
 */
import { pipeline, env } from "@huggingface/transformers";

env.allowLocalModels = false;
env.useBrowserCache = true;

interface InitMessage {
  id: string;
  type: "init";
  modelId: string;
  /** "webgpu" | "wasm". Caller's capability hook decides. */
  device: "webgpu" | "wasm";
}
interface TranscribeMessage {
  id: string;
  type: "transcribe";
  /** Mono 16 kHz PCM. Sent as a transferable so we don't copy the
   *  buffer across the worker boundary. */
  pcm: Float32Array;
  /** chunk_length_s — Whisper's canonical 30s window. */
  chunkLengthSeconds: number;
  /** stride_length_s — overlap between consecutive chunks so word
   *  boundaries aren't cut (typically 5s). */
  strideLengthSeconds: number;
}
type Incoming = InitMessage | TranscribeMessage;

type WhisperResult = {
  text: string;
  chunks?: Array<{
    text: string;
    timestamp: [number, number | null];
  }>;
};

type AsrFn = (
  audio: Float32Array,
  opts: {
    chunk_length_s: number;
    stride_length_s: number;
    return_timestamps: boolean | "word";
    task: "transcribe" | "translate";
    language?: string;
  }
) => Promise<WhisperResult>;

let asr: AsrFn | null = null;
let activeModelId: string | null = null;

async function ensureAsr(modelId: string, device: "webgpu" | "wasm") {
  // If already loaded with the same model, bail. Switching models
  // means re-loading from scratch — uncommon, only happens when the
  // capability tier changes mid-session.
  if (asr && activeModelId === modelId) return;
  const loaded = (await pipeline(
    "automatic-speech-recognition",
    modelId,
    { device } as Parameters<typeof pipeline>[2]
  )) as unknown as AsrFn;
  asr = loaded;
  activeModelId = modelId;
}

self.onmessage = async (e: MessageEvent<Incoming>) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      // Tell the main thread we're starting so the indicator can show
      // "loading model" rather than going silent for several seconds
      // on first run (the weights are 39MB+ over the network).
      (self as unknown as Worker).postMessage({
        id: msg.id,
        type: "phase",
        phase: "loading-model"
      });
      await ensureAsr(msg.modelId, msg.device);
      (self as unknown as Worker).postMessage({
        id: msg.id,
        type: "ready"
      });
      return;
    }

    if (msg.type === "transcribe") {
      if (!asr) {
        throw new Error("Whisper not initialised. Call type:init first.");
      }
      (self as unknown as Worker).postMessage({
        id: msg.id,
        type: "phase",
        phase: "transcribing"
      });
      // Whisper's pipeline doesn't expose progress callbacks; we get
      // one final result. Our pipeline coordinator on the main thread
      // animates a smoothed progress bar based on elapsed time vs an
      // expected RTF. That's why we emit `transcribing` once here and
      // the rest is timer-driven.
      const result = await asr(msg.pcm, {
        chunk_length_s: msg.chunkLengthSeconds,
        stride_length_s: msg.strideLengthSeconds,
        return_timestamps: true,
        task: "transcribe",
        language: "en"
      });
      (self as unknown as Worker).postMessage({
        id: msg.id,
        type: "result",
        payload: result
      });
      return;
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: msg.id,
      type: "error",
      error: (err as Error).message
    });
  }
};

export {};

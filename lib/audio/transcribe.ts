/**
 * v1.7.3 — Public transcription API.
 *
 * Coordinates extract → worker init → ASR → cache. Owns the lone
 * Whisper worker for the whole tab (one instance, serialized jobs).
 * The worker is created lazily on first `transcribe()` call so users
 * who never hit the audio path pay zero overhead.
 *
 *   import { transcribe } from "@/lib/audio/transcribe";
 *   const t = await transcribe({ blob, sourceHash, onProgress });
 *
 * Behaviour:
 *   - Cache hit (same hash + same model) returns instantly.
 *   - Cache miss extracts PCM, sends it to the worker, awaits the
 *     result, saves to cache, returns.
 *   - onProgress fires for each phase change + a smoothed timer
 *     while the worker is busy.
 *   - Concurrent calls are serialized — second call waits in line.
 */

import { newId } from "@/lib/util/id";
import { AUDIO } from "@/lib/config";
import { cloudAnalysisEnabled } from "@/lib/ai/cloudAnalysisPreference";
import {
  extractMonoPCM16k,
  probeHasAudio
} from "./extract";
import { encodeWavBase64 } from "./wav";
import { getTranscript, saveTranscript } from "./cache";
import type {
  TranscribeOptions,
  TranscribeProgress,
  Transcript,
  TranscriptSegment
} from "./types";

/** Cache/model id for transcripts produced by the cloud (OpenRouter) path.
 *  Distinct from the on-device Whisper model ids so a device that flips the
 *  toggle doesn't collide caches. */
const CLOUD_TRANSCRIBE_MODEL = "cloud:openrouter-audio";

/** Upper bound (seconds) on audio we send to the cloud transcription route.
 *  Beyond this the WAV payload gets large and most free audio models cap their
 *  context anyway, so we fall back to on-device Whisper for long sources. */
const CLOUD_TRANSCRIBE_MAX_SECONDS = 600;

// ---- Worker singleton ------------------------------------------------

/** One whisper worker per tab, lazy-created. The worker file lives
 *  next to this module so its import paths resolve identically in
 *  dev (next dev) and prod (next build).
 *
 *  We keep a single in-flight Promise to serialize jobs: Whisper
 *  inference is heavy on GPU memory and running two at once would
 *  thrash. A queue is fine because users typically transcribe one
 *  source at a time. */
let worker: Worker | null = null;
let workerReady: Promise<void> | null = null;
let workerModel: string | null = null;
let inFlight: Promise<unknown> = Promise.resolve();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./whisper.worker.ts", import.meta.url), {
    type: "module"
  });
  return worker;
}

/** Send a one-shot message to the worker and resolve when the worker
 *  emits a matching reply (matched by message id). All progress and
 *  intermediate `phase` events are forwarded to onProgress. */
function callWorker<T>(args: {
  type: string;
  payload?: Record<string, unknown>;
  transferables?: Transferable[];
  onPhase?: (phase: string) => void;
  signal?: AbortSignal;
}): Promise<T> {
  const w = getWorker();
  const id = newId("ww");
  return new Promise<T>((resolve, reject) => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as {
        id: string;
        type?: string;
        phase?: string;
        payload?: T;
        error?: string;
      };
      if (data.id !== id) return;
      if (data.type === "phase" && data.phase) {
        args.onPhase?.(data.phase);
        return;
      }
      if (data.type === "error") {
        cleanup();
        reject(new Error(data.error ?? "Worker error"));
        return;
      }
      // type === "ready" or "result" — both terminate the promise
      // depending on which message we expected.
      cleanup();
      resolve(data.payload as T);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => {
      w.removeEventListener("message", onMessage);
      args.signal?.removeEventListener("abort", onAbort);
    };
    w.addEventListener("message", onMessage);
    args.signal?.addEventListener("abort", onAbort);
    w.postMessage({ id, type: args.type, ...(args.payload ?? {}) }, args.transferables ?? []);
  });
}

async function ensureWorkerReady(modelId: string, device: "webgpu" | "wasm") {
  if (worker && workerReady && workerModel === modelId) return workerReady;
  // Reset if the model changed (capability tier shifted). We close
  // the old worker so its weights are released; ASR weights can be
  // hundreds of MB on disk.
  if (worker && workerModel !== modelId) {
    worker.terminate();
    worker = null;
  }
  getWorker(); // create a fresh worker
  workerModel = modelId;
  workerReady = callWorker<void>({
    type: "init",
    payload: { modelId, device }
  });
  return workerReady;
}

// ---- Public API ------------------------------------------------------

/** Resolve a model id from the capability tier. */
function pickModel(tier: "high" | "mid" | "low" | "off"): string {
  if (tier === "off") return "";
  if (tier === "high") return AUDIO.modelHigh;
  if (tier === "mid") return AUDIO.modelMid;
  return AUDIO.modelLow;
}

/** Resolve a target device from capability flags. */
function pickDevice(hasWebGPU: boolean): "webgpu" | "wasm" {
  return hasWebGPU ? "webgpu" : "wasm";
}

export interface TranscribeArgs extends TranscribeOptions {
  /** Capability tier from useCapability. Drives model + device choice.
   *  Phase 1 only ships English-only models so we hard-code language
   *  = "en"; multilingual is a follow-up. */
  audioTier: "high" | "mid" | "low" | "off";
  hasWebGPU: boolean;
}

/** Transcribe a video. See module docblock + types.ts for shape. */
export async function transcribe(args: TranscribeArgs): Promise<Transcript> {
  if (args.audioTier === "off") {
    throw new Error("Audio transcription is disabled on this device.");
  }

  // --- MOCK FOR AUTOMATION ---
  if (typeof window !== "undefined" && window.localStorage.getItem("DISABLE_WEBLLM") === "1") {
    console.log("TEST MODE: Mocking transcription");
    const onProgress = args.onProgress ?? (() => {});
    onProgress({ phase: "done", progress: 1 });
    return {
      sourceHash: args.sourceHash,
      sourceId: args.sourceId,
      language: "en",
      model: "mock-whisper",
      ts: Date.now(),
      durationSeconds: 30,
      transcribeMs: 100,
      segments: [{
        id: "mock_seg",
        start: 0,
        end: 30,
        text: "Make a 30 sec shorts talk like a human and friendly."
      }],
      fullText: "Make a 30 sec shorts talk like a human and friendly.",
      signals: { hasSpeech: true }
    };
  }

  const modelId = args.modelId ?? pickModel(args.audioTier);
  const device = pickDevice(args.hasWebGPU);
  const onProgress = args.onProgress ?? (() => {});

  // ---- Cloud analysis path (toggle ON) ------------------------------
  // When the cloud-analysis toggle is enabled, transcribe via the free
  // OpenRouter analysis model first — typically much faster than downloading
  // and running Whisper on-device. On-device Whisper remains the guaranteed
  // fallback (OFFLINE EDIT): any failure here falls through to the local path.
  if (cloudAnalysisEnabled()) {
    if (!args.force) {
      const cachedCloud = await getTranscript(args.sourceHash, CLOUD_TRANSCRIBE_MODEL);
      if (cachedCloud) {
        onProgress({ phase: "done", progress: 1 });
        return cachedCloud;
      }
    }
    try {
      const cloud = await transcribeViaCloud(args, onProgress);
      await saveTranscript(cloud);
      onProgress({
        phase: "done",
        progress: 1,
        detail: `${cloud.segments.length} segment${cloud.segments.length === 1 ? "" : "s"} · cloud`
      });
      return cloud;
    } catch (err) {
      // A user cancel must propagate; everything else falls back to on-device.
      if ((err as Error).name === "AbortError") {
        onProgress({ phase: "error", progress: 0, error: "cancelled" });
        throw err;
      }
      // Soft-fall-through: keep the offline guarantee. The local path below
      // runs exactly as if the toggle were off.
    }
  }

  // ---- Cache hit? ---------------------------------------------------
  if (!args.force) {
    const cached = await getTranscript(args.sourceHash, modelId);
    if (cached) {
      onProgress({ phase: "done", progress: 1 });
      return cached;
    }
  }

  // Serialize concurrent transcribe calls. The worker is single-slot
  // so launching two parallel jobs would just thrash. Wait in line.
  const myTurn = inFlight.catch(() => undefined);
  let release: () => void = () => undefined;
  inFlight = new Promise<void>((res) => {
    release = res;
  });
  await myTurn;

  try {
    onProgress({ phase: "queued", progress: 0 });

    // ---- Decode audio ----------------------------------------------
    onProgress({ phase: "decoding", progress: 0 });
    const hasAudio = await probeHasAudio(args.blob);
    if (!hasAudio) {
      // Empty transcript so callers don't have to special-case null.
      // We still cache it — re-checking a silent file is wasteful.
      const empty: Transcript = {
        sourceHash: args.sourceHash,
        sourceId: args.sourceId,
        language: "en",
        model: modelId,
        ts: Date.now(),
        durationSeconds: 0,
        transcribeMs: 0,
        segments: [],
        fullText: "",
        signals: { hasSpeech: false }
      };
      await saveTranscript(empty);
      onProgress({ phase: "done", progress: 1, detail: "no speech detected" });
      return empty;
    }

    const pcm = await extractMonoPCM16k(args.blob);
    onProgress({
      phase: "decoding",
      progress: 1,
      detail: `${(pcm.length / 16_000).toFixed(1)}s of audio`
    });

    if (args.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    // ---- Init worker ------------------------------------------------
    onProgress({ phase: "loading-model", progress: 0 });
    await ensureWorkerReady(modelId, device);
    onProgress({ phase: "loading-model", progress: 1 });

    if (args.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    // ---- Run ASR ----------------------------------------------------
    onProgress({ phase: "transcribing", progress: 0 });
    const t0 = performance.now();

    // Whisper doesn't expose progress callbacks, so we run a smoothed
    // timer on the main thread. Expected RTF varies by model + device:
    //   - whisper-tiny.en + WebGPU on a mid laptop: ~3-5x realtime
    //   - whisper-tiny.en + WASM: ~0.7-1.2x realtime
    // We pick a safe floor (1x realtime) so the bar never overshoots.
    const expectedRtf =
      device === "webgpu" ? AUDIO.expectedRtfWebGPU : AUDIO.expectedRtfWasm;
    const expectedMs = (pcm.length / 16_000 / expectedRtf) * 1000;
    let timerProgress = 0;
    const timer = setInterval(() => {
      const elapsed = performance.now() - t0;
      timerProgress = Math.min(0.95, elapsed / expectedMs);
      onProgress({
        phase: "transcribing",
        progress: timerProgress,
        detail: `${(elapsed / 1000).toFixed(0)}s elapsed`
      });
    }, 250);

    let result: { text?: string; chunks?: Array<{ text: string; timestamp: [number, number | null] }> };
    try {
      // Transferable PCM so we don't copy ~MB of samples across the
      // worker boundary. After this call our `pcm` is detached.
      const pcmCopy = pcm.slice();
      result = await callWorker<typeof result>({
        type: "transcribe",
        payload: {
          pcm: pcmCopy,
          chunkLengthSeconds: AUDIO.chunkLengthSeconds,
          strideLengthSeconds: AUDIO.strideLengthSeconds
        },
        transferables: [pcmCopy.buffer],
        signal: args.signal
      });
    } finally {
      clearInterval(timer);
    }

    const transcribeMs = performance.now() - t0;

    // ---- Normalise into our Transcript shape -----------------------
    const segments: TranscriptSegment[] = [];
    if (Array.isArray(result.chunks)) {
      for (const c of result.chunks) {
        const start = Number.isFinite(c.timestamp?.[0]) ? c.timestamp![0]! : 0;
        const end = Number.isFinite(c.timestamp?.[1] ?? NaN)
          ? c.timestamp![1]!
          : start + 1;
        const text = (c.text ?? "").trim();
        if (!text) continue;
        if (end <= start) continue;
        segments.push({ id: newId("seg"), start, end, text });
      }
    }

    // Fallback: if the model returned only top-level `text` with no
    // chunks, wrap the whole thing as one segment with audio-length
    // bounds. Loses timing precision but keeps consumers consistent.
    if (segments.length === 0 && typeof result.text === "string" && result.text.trim()) {
      segments.push({
        id: newId("seg"),
        start: 0,
        end: pcm.length / 16_000,
        text: result.text.trim()
      });
    }

    const fullText = segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();

    const out: Transcript = {
      sourceHash: args.sourceHash,
      sourceId: args.sourceId,
      language: "en",
      model: modelId,
      ts: Date.now(),
      durationSeconds: pcm.length / 16_000,
      transcribeMs,
      segments,
      fullText,
      signals: { hasSpeech: segments.length > 0 }
    };

    await saveTranscript(out);
    onProgress({
      phase: "done",
      progress: 1,
      detail: `${segments.length} segment${segments.length === 1 ? "" : "s"}`
    });
    return out;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      onProgress({ phase: "error", progress: 0, error: "cancelled" });
    } else {
      onProgress({
        phase: "error",
        progress: 0,
        error: (err as Error).message
      });
    }
    throw err;
  } finally {
    release();
  }
}

/**
 * Cloud transcription via the OpenRouter analysis model. Extracts mono 16 kHz
 * audio locally, encodes it to WAV, and POSTs it to /api/audio/transcribe.
 * Returns a Transcript in the SAME shape as the on-device path so every
 * consumer (cache, grounding, drawer) is unchanged. Throws on any failure so
 * the caller can fall back to on-device Whisper.
 */
async function transcribeViaCloud(
  args: TranscribeArgs,
  onProgress: (p: TranscribeProgress) => void
): Promise<Transcript> {
  onProgress({ phase: "decoding", progress: 0 });

  const hasAudio = await probeHasAudio(args.blob);
  if (!hasAudio) {
    // No speech track — return (and cache) an empty cloud transcript so we
    // don't re-probe a silent file every run.
    return {
      sourceHash: args.sourceHash,
      sourceId: args.sourceId,
      language: "en",
      model: CLOUD_TRANSCRIBE_MODEL,
      ts: Date.now(),
      durationSeconds: 0,
      transcribeMs: 0,
      segments: [],
      fullText: "",
      signals: { hasSpeech: false }
    };
  }

  const pcm = await extractMonoPCM16k(args.blob);
  const durationSeconds = pcm.length / 16_000;
  if (durationSeconds > CLOUD_TRANSCRIBE_MAX_SECONDS) {
    // Too long for the cloud payload — fall back to on-device.
    throw new Error(
      `audio ${Math.round(durationSeconds)}s exceeds cloud cap ${CLOUD_TRANSCRIBE_MAX_SECONDS}s`
    );
  }
  if (args.signal?.aborted) throw new DOMException("Aborted", "AbortError");

  onProgress({ phase: "transcribing", progress: 0, detail: "cloud model" });
  const audioBase64 = await encodeWavBase64(pcm, 16_000);
  const t0 = performance.now();

  const resp = await fetch("/api/audio/transcribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ audioBase64, format: "wav", durationSeconds }),
    signal: args.signal
  });
  if (!resp.ok) {
    throw new Error(`cloud transcribe failed [${resp.status}]`);
  }
  const json = (await resp.json()) as {
    language?: string;
    segments?: Array<{ start: number; end: number; text: string }>;
    fullText?: string;
  };
  const transcribeMs = performance.now() - t0;

  const segments: TranscriptSegment[] = (json.segments ?? [])
    .filter((s) => typeof s?.text === "string" && s.text.trim())
    .map((s) => ({
      id: newId("seg"),
      start: Math.max(0, Number(s.start) || 0),
      end: Math.max(Number(s.start) || 0, Number(s.end) || 0) || (Number(s.start) || 0) + 1,
      text: s.text.trim()
    }));
  const fullText =
    json.fullText?.trim() ||
    segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();

  return {
    sourceHash: args.sourceHash,
    sourceId: args.sourceId,
    language: typeof json.language === "string" ? json.language : "en",
    model: CLOUD_TRANSCRIBE_MODEL,
    ts: Date.now(),
    durationSeconds,
    transcribeMs,
    segments,
    fullText,
    signals: { hasSpeech: segments.length > 0 }
  };
}

/** Returns whether transcription is supported in this browser. Used
 *  by useCapability to decide the audio tier; called from React but
 *  doesn't import React. */
export function isTranscriptionSupported(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof Worker === "undefined") return false;
  if (typeof OfflineAudioContext === "undefined") return false;
  if (
    typeof window.AudioContext === "undefined" &&
    typeof (window as unknown as { webkitAudioContext?: unknown })
      .webkitAudioContext === "undefined"
  )
    return false;
  return true;
}

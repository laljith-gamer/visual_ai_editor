/**
 * v1.7.3 — Audio understanding types.
 *
 * The transcription pipeline produces a `Transcript` keyed by source
 * hash. The same hash drives the existing per-source caches (frame
 * scores, video metadata) so a re-uploaded file always hits both.
 *
 * Phase 1 scope: ASR only. The richer audio-events surface (laughter,
 * applause, music vs speech) lives behind a `signals` field that's
 * declared here but not produced yet.
 */

/** One contiguous chunk of recognized speech with timestamps relative
 *  to the start of the source video. */
export interface TranscriptSegment {
  /** Stable id; useful as a React key and for clip→snippet lookups. */
  id: string;
  /** Seconds from start of the source. */
  start: number;
  /** Seconds from start of the source. Always > start. */
  end: number;
  /** Recognized text. Plain ASCII / unicode; no markup. */
  text: string;
  /** Optional 0..1 confidence reported by the ASR model. Whisper
   *  doesn't expose this directly; we leave it `undefined` for now.
   *  Future work could derive it from log-prob or VAD score. */
  confidence?: number;
}

/** Full transcript for a single source. */
export interface Transcript {
  /** sha256 of the source video bytes — the same hash used everywhere
   *  else for caching. Two videos with identical bytes share one
   *  transcript. */
  sourceHash: string;
  /** Source id at the time of transcription; for display only. The
   *  hash is the actual cache key. */
  sourceId?: string;
  /** Detected language ISO code ("en", "ja", etc). Currently always
   *  "en" because we ship whisper-tiny.en first; multilingual support
   *  is a follow-up. */
  language: string;
  /** ASR model identifier ("Xenova/whisper-tiny.en"). Used to
   *  invalidate the cache when we upgrade models. */
  model: string;
  /** Wall-clock timestamp the transcript was finalised. */
  ts: number;
  /** Total source duration in seconds (for progress / display). */
  durationSeconds: number;
  /** Wall-clock seconds the transcription took (for the indicator). */
  transcribeMs: number;
  /** Ordered list of recognized speech segments. May be empty if the
   *  source has no speech. */
  segments: TranscriptSegment[];
  /** Concatenated text of every segment, separated by single spaces.
   *  Cached here so consumers (briefing, search) don't need to
   *  re-join on every read. */
  fullText: string;
  /** Phase-3 audio-event signals. Populated by a future audio
   *  classifier; declared now so consumers can opt-in early without
   *  another type bump. */
  signals?: {
    /** True iff at least one segment was produced. Cheap signal that
     *  "audio carries meaning here". */
    hasSpeech: boolean;
    /** Reserved for AST/YAMNet output (laughter, applause, music). */
    events?: Array<{
      kind: string;
      start: number;
      end: number;
      score: number;
    }>;
  };
}

/** Live progress reported by the transcription pipeline. */
export interface TranscribeProgress {
  /** Stage of the pipeline. The same enum drives the indicator UI. */
  phase:
    | "queued"
    | "decoding" // PCM extract from blob
    | "loading-model" // Whisper weights download / WebGPU init
    | "transcribing" // ASR running on PCM samples
    | "done"
    | "error";
  /** 0..1 fraction of the current phase OR overall, depending on
   *  phase. Best-effort. UI smooths jitter. */
  progress: number;
  /** Optional one-line detail for the indicator ("0:42 / 2:15"). */
  detail?: string;
  /** When phase = "error", the human-readable failure cause. */
  error?: string;
}

/** What the public `transcribe()` API accepts. */
export interface TranscribeOptions {
  /** Required. The source video Blob. Audio is decoded from this
   *  via Web Audio API (no extra deps). */
  blob: Blob;
  /** Required. sha256 hash for cache lookup. The caller already
   *  computes this on upload (lib/util/hash.ts) so we reuse it. */
  sourceHash: string;
  /** Optional source id, surfaced in progress events. */
  sourceId?: string;
  /** Optional progress callback. Fires every couple hundred ms while
   *  the pipeline is running. */
  onProgress?: (p: TranscribeProgress) => void;
  /** Optional override for the ASR model id. Defaults to whichever
   *  the capability tier resolved to; passing a value lets tests pin
   *  a specific model. */
  modelId?: string;
  /** AbortSignal to cancel mid-flight. Resolves with the
   *  partial transcript (whatever segments completed). */
  signal?: AbortSignal;
  /** Force a fresh run even if a cached transcript exists. Used by
   *  the "Re-transcribe" UI affordance. */
  force?: boolean;
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useEditorStore } from "@/hooks/useEditorStore";
import { useCapability } from "@/hooks/useCapability";
import { transcribe } from "@/lib/audio/transcribe";
import { getTranscript } from "@/lib/audio/cache";
import type { TranscribeProgress, Transcript } from "@/lib/audio/types";
import { logSystem } from "@/lib/log/recorders";

/**
 * v1.7.3 — High-level hook for the transcription pipeline.
 *
 * Two responsibilities:
 *
 * 1. EXPOSE STATE — The current transcript for the active source (if
 *    any), plus live progress for the most recent transcribe call.
 *    Components import this when they need to render the transcript
 *    (TranscriptDrawer, ClipInspector snippet, etc).
 *
 * 2. KICK OFF JOBS — `start({ sourceId })` triggers a transcription run
 *    for the named source. Idempotent: cache hits return immediately,
 *    in-flight jobs are deduped, repeat calls are no-ops while the
 *    pipeline is running.
 *
 * The hook deliberately doesn't auto-start jobs on its own. The
 * /launch page calls `start()` once after a successful upload; nothing
 * else does. That keeps the trigger surface tight and predictable.
 */

export interface UseTranscriptionResult {
  /** Transcript for the currently active source, if known. May be
   *  populated from cache on mount. */
  transcript: Transcript | null;
  /** Live progress for the most recent transcribe job. null when
   *  idle. Updates several times a second while running. */
  progress: TranscribeProgress | null;
  /** Convenience: true while a transcribe is in flight for any
   *  source. UI uses this to show the indicator. */
  isRunning: boolean;
  /** Trigger a transcribe for the given source. Returns the cached
   *  promise if one is already in flight for this source, so multiple
   *  callers naturally dedupe. */
  start: (args: {
    sourceId: string;
    /** Pass true to ignore the IDB cache and re-run from scratch. */
    force?: boolean;
  }) => Promise<Transcript | null>;
  /** Whether transcription is supported at all on this device. */
  enabled: boolean;
}

export function useTranscription(): UseTranscriptionResult {
  const cap = useCapability();
  const sources = useEditorStore((s) => s.sources);
  const activeSourceId = useEditorStore((s) => s.activeSourceId);
  const transcripts = useEditorStore((s) => s.transcripts);
  const setTranscript = useEditorStore((s) => s.setTranscript);
  const sessionId = useEditorStore((s) => s.sessionId);

  const [progress, setProgress] = useState<TranscribeProgress | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  // Per-hash in-flight promises so concurrent callers (page + drawer
  // + briefing) all wait on a single shared transcribe call.
  const inFlightRef = useRef<Map<string, Promise<Transcript | null>>>(
    new Map()
  );

  const enabled = cap.audioTier !== "off";

  // ---- Hydrate from IDB on mount ------------------------------------
  // When the user reloads the editor or restores a session, the
  // in-memory `transcripts` slot is empty but IDB might still have a
  // valid cached transcript from a previous run. Pull every active
  // source's hash and load opportunistically. Misses are silent.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      for (const src of sources) {
        if (transcripts[src.hash]) continue;
        const cached = await getTranscript(src.hash);
        if (cancelled) return;
        if (cached) setTranscript(src.hash, cached);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, enabled]);

  const start = useCallback<UseTranscriptionResult["start"]>(
    async ({ sourceId, force }) => {
      if (!enabled) return null;
      const source =
        sources.find((s) => s.id === sourceId) ?? null;
      if (!source) return null;

      // Dedupe by hash: if there's already an in-flight job for this
      // hash, return the same promise. Multiple components can call
      // start() concurrently without duplicating work.
      const existing = inFlightRef.current.get(source.hash);
      if (existing && !force) return existing;

      setIsRunning(true);
      setProgress({ phase: "queued", progress: 0 });

      const job = (async () => {
        try {
          const t = await transcribe({
            blob: source.blob,
            sourceHash: source.hash,
            sourceId: source.id,
            audioTier: cap.audioTier,
            hasWebGPU: cap.hasWebGPU,
            force,
            onProgress: (p) => setProgress(p)
          });
          setTranscript(source.hash, t);
          logSystem({
            sessionId,
            kind: "transcript.ready",
            payload: {
              sourceId: source.id,
              segments: t.segments.length,
              durationSeconds: Math.round(t.durationSeconds),
              transcribeMs: Math.round(t.transcribeMs),
              model: t.model
            },
            summary: `Transcribed "${source.meta.name}" — ${t.segments.length} segment${t.segments.length === 1 ? "" : "s"} (${(t.transcribeMs / 1000).toFixed(1)}s)`
          });
          return t;
        } catch (err) {
          const message = (err as Error).message || "Transcription failed";
          // PHASE 4: never silently return to "No transcript yet". Surface
          // an explicit error phase so the UI can show the real reason
          // (no audio track / decode failed / model load failed / etc.).
          setProgress({ phase: "error", progress: 0, error: message });
          logSystem({
            sessionId,
            kind: "transcript.failed",
            payload: {
              sourceId: source.id,
              message
            },
            summary: `Transcribe failed: ${message.slice(0, 80)}`
          });
          return null;
        } finally {
          inFlightRef.current.delete(source.hash);
          // Clear running flag only after the LAST in-flight job ends.
          if (inFlightRef.current.size === 0) {
            setIsRunning(false);
          }
        }
      })();
      inFlightRef.current.set(source.hash, job);
      return job;
    },
    [enabled, sources, cap.audioTier, cap.hasWebGPU, setTranscript, sessionId]
  );

  // Resolve the transcript for the currently active source.
  const activeSource = sources.find((s) => s.id === activeSourceId) ?? null;
  const transcript = activeSource ? transcripts[activeSource.hash] ?? null : null;

  return { transcript, progress, isRunning, start, enabled };
}

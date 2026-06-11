/**
 * v1.7.3 — IDB cache for transcripts.
 *
 * Keyed by `sourceHash` (sha256 of the video bytes), value is the
 * full Transcript object.
 *
 * v1.8.x — moved to its OWN database ("shorts-studio-transcripts") via the
 * self-healing layer in lib/store/idb.ts. It previously shared the
 * "shorts-studio-cache" database name with the predictions cache but used a
 * different object store ("transcripts" vs "kv"). idb-keyval only creates
 * the first object store a database ever sees, so whichever opened second
 * hit "object store not found" and crashed the app. A dedicated database
 * removes that collision entirely; safeGet/Set/Del add missing-store
 * recovery on top.
 *
 * Cache invalidation:
 *   - Re-uploads of the same file hit by hash.
 *   - Switching ASR models bumps the cache miss because we include
 *     the model id in the validity check (see `getTranscript`).
 *   - The user's "Re-transcribe" UI affordance calls `clear(hash)`
 *     and force-runs.
 *   - There is no time-based TTL. Transcripts are durable session
 *     artefacts; the user clears them by clearing the library.
 */
import { safeGet, safeSet, safeDel } from "@/lib/store/idb";
import type { Transcript } from "./types";

/** Read a transcript for the given hash + model. Returns null on
 *  miss or when the cached entry was produced by a different model. */
export async function getTranscript(
  sourceHash: string,
  expectedModel?: string
): Promise<Transcript | null> {
  if (!sourceHash) return null;
  try {
    const cached = await safeGet<Transcript>("transcripts", sourceHash);
    if (!cached) return null;
    if (expectedModel && cached.model !== expectedModel) return null;
    return cached;
  } catch {
    // IDB can fail in private-browsing on some browsers; treat any
    // unexpected error as a soft cache miss rather than blowing up
    // the launch flow.
    return null;
  }
}

export async function saveTranscript(t: Transcript): Promise<void> {
  if (!t.sourceHash) return;
  try {
    await safeSet("transcripts", t.sourceHash, t);
  } catch {
    // Quota errors fall through silently; the user just re-transcribes
    // next visit. Better than crashing.
  }
}

export async function clearTranscript(sourceHash: string): Promise<void> {
  try {
    await safeDel("transcripts", sourceHash);
  } catch {
    /* ignore */
  }
}

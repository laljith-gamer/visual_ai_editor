/**
 * v1.7.3 — IDB cache for transcripts.
 *
 * Keyed by `sourceHash` (sha256 of the video bytes), value is the
 * full Transcript object. We use idb-keyval (already a dep) under a
 * dedicated namespace so transcripts don't collide with the existing
 * predictions cache or the session store.
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
import { createStore, get as idbGet, set as idbSet, del as idbDel } from "idb-keyval";
import type { Transcript } from "./types";

// Dedicated IDB store so cache lifecycle stays isolated from the
// predictions cache. Same database name as the rest of the app to
// avoid creating a second IDB connection.
const store = createStore("shorts-studio-cache", "transcripts");

/** Read a transcript for the given hash + model. Returns null on
 *  miss or when the cached entry was produced by a different model. */
export async function getTranscript(
  sourceHash: string,
  expectedModel?: string
): Promise<Transcript | null> {
  if (!sourceHash) return null;
  try {
    const cached = (await idbGet(sourceHash, store)) as Transcript | undefined;
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
    await idbSet(t.sourceHash, t, store);
  } catch {
    // Quota errors fall through silently; the user just re-transcribes
    // next visit. Better than crashing.
  }
}

export async function clearTranscript(sourceHash: string): Promise<void> {
  try {
    await idbDel(sourceHash, store);
  } catch {
    /* ignore */
  }
}

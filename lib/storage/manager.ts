/**
 * Phase 3 — storage / cache manager (browser).
 *
 * Measures and cleans the local caches so the site never silently grows
 * to multiple GB. All measurement is on-demand (driven by the storage
 * panel), feature-detected, and degrades to zeros when an API is missing
 * (e.g. server / node). Cleanup actions are explicit user actions.
 *
 * Category mapping:
 *   - model       → Cache Storage entries (transformers.js / Whisper /
 *                   WebLLM model weights)
 *   - frame       → idb "cache" (sampled-frame predictions)
 *   - transcript  → idb "transcripts"
 *   - render      → the in-memory rendered blob (not persisted)
 *   - project     → idb sessions + logs + video-memory + agent-memory
 */

import {
  IDB_DATABASE_NAMES,
  deleteDatabaseSafe,
  resetAllLocalDatabases,
  safeGet,
  safeKeys,
  safeDel,
  type IdbKind
} from "@/lib/store/idb";
import { useEditorStore } from "@/hooks/useEditorStore";
import { emptyBreakdown, type StorageBreakdown } from "./budget";

const isBrowser = typeof window !== "undefined";

/** Approximate the byte size of a stored idb value. */
function approxSize(value: unknown): number {
  if (value == null) return 0;
  if (typeof Blob !== "undefined" && value instanceof Blob) return value.size;
  if (value instanceof ArrayBuffer) return value.byteLength;
  try {
    // UTF-16 string length is a rough byte proxy; good enough for a panel.
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Sum approximate sizes across one idb store. */
async function sumKind(kind: IdbKind): Promise<number> {
  if (!isBrowser || typeof indexedDB === "undefined") return 0;
  try {
    const keys = await safeKeys(kind);
    let total = 0;
    for (const k of keys) {
      const v = await safeGet<unknown>(kind, k as IDBValidKey);
      total += approxSize(v);
    }
    return total;
  } catch {
    return 0;
  }
}

/** Sum cached model weights via the Cache Storage API. Uses Content-Length
 *  headers when present (cheap); falls back to reading the blob size. */
async function sumModelCaches(): Promise<number> {
  if (!isBrowser || typeof caches === "undefined") return 0;
  try {
    const names = await caches.keys();
    let total = 0;
    for (const name of names) {
      const cache = await caches.open(name);
      const reqs = await cache.keys();
      for (const req of reqs) {
        const res = await cache.match(req);
        if (!res) continue;
        const len = res.headers.get("content-length");
        if (len) {
          total += parseInt(len, 10) || 0;
        } else {
          try {
            const blob = await res.clone().blob();
            total += blob.size;
          } catch {
            // opaque response — skip
          }
        }
      }
    }
    return total;
  } catch {
    return 0;
  }
}

/** Best-effort total local usage reported by the platform. */
async function platformUsage(): Promise<number> {
  if (!isBrowser || !navigator.storage?.estimate) return 0;
  try {
    const est = await navigator.storage.estimate();
    return est.usage ?? 0;
  } catch {
    return 0;
  }
}

/** Measure the full storage breakdown. On-demand (can read many idb
 *  values) — call it when opening the storage panel, not on a hot path. */
export async function estimateStorageBreakdown(): Promise<StorageBreakdown> {
  if (!isBrowser) return emptyBreakdown();

  const [modelBytes, frameBytes, transcriptBytes, sessionsBytes, logsBytes, videoMemBytes, agentMemBytes, platform] =
    await Promise.all([
      sumModelCaches(),
      sumKind("cache"),
      sumKind("transcripts"),
      sumKind("sessions"),
      sumKind("logs"),
      sumKind("videoMemory"),
      sumKind("agentMemory"),
      platformUsage()
    ]);

  const renderBytes = useEditorStore.getState().renderedBlob?.size ?? 0;
  const projectBytes = sessionsBytes + logsBytes + videoMemBytes + agentMemBytes;
  const sum = modelBytes + frameBytes + transcriptBytes + renderBytes + projectBytes;

  return {
    modelBytes,
    frameBytes,
    transcriptBytes,
    renderBytes,
    projectBytes,
    // Prefer the platform's number when it's larger (it includes overhead
    // / Cache entries we couldn't size precisely).
    totalBytes: Math.max(sum, platform)
  };
}

// ---------------------------------------------------------------------
// Cleanup actions
// ---------------------------------------------------------------------

async function clearKind(kind: IdbKind): Promise<void> {
  if (!isBrowser || typeof indexedDB === "undefined") return;
  try {
    const keys = await safeKeys(kind);
    await Promise.all(keys.map((k) => safeDel(kind, k as IDBValidKey)));
  } catch {
    // ignore
  }
}

/** Clear the in-memory rendered file. */
export function clearRenderedFiles(): void {
  if (!isBrowser) return;
  useEditorStore.getState().setRendered(null);
}

/** Clear the sampled-frame prediction cache. */
export function clearFrameCache(): Promise<void> {
  return clearKind("cache");
}

/** Clear cached transcripts. */
export function clearTranscriptCache(): Promise<void> {
  return clearKind("transcripts");
}

/** Names this app considers "its own" model caches. Conservative — only
 *  caches whose name looks like a model/asset cache are removed. */
const MODEL_CACHE_RE = /transformers|onnx|webllm|mlc|huggingface|hf-|model|whisper|siglip/i;

/** Delete cached model weights (Cache Storage). Returns how many caches
 *  were removed. Leaves the app shell / PWA cache untouched. */
export async function clearModelCaches(): Promise<number> {
  if (!isBrowser || typeof caches === "undefined") return 0;
  try {
    const names = await caches.keys();
    let removed = 0;
    for (const name of names) {
      if (MODEL_CACHE_RE.test(name)) {
        if (await caches.delete(name)) removed += 1;
      }
    }
    return removed;
  } catch {
    return 0;
  }
}

/** Nuke ALL local project data (sessions, caches, logs, memory) and the
 *  rendered file. Model caches are left to `clearModelCaches`. */
export async function clearAllProjectData(): Promise<void> {
  if (!isBrowser) return;
  clearRenderedFiles();
  await resetAllLocalDatabases();
}

/** The databases this app owns — exposed for the panel's "clear all". */
export const OWNED_DATABASES = IDB_DATABASE_NAMES;

/** Best-effort single-DB delete (panel helper). */
export function deleteDatabase(name: string): Promise<void> {
  return deleteDatabaseSafe(name);
}

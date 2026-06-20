// =====================================================================
// lib/analysis/videoMemoryManager.ts
//
// Runtime "VideoMemoryManager": a thin browser-only layer that keeps an
// in-memory map of VideoAnalysisMemory (keyed by videoHash) for SYNCHRONOUS
// reads during a turn, backed by the idb-keyval videoMemoryStore for
// persistence across refresh / re-upload. This is what makes the dynamic
// analysis "remember the video after scanning" and reuse it on the next
// prompt.
//
// The decision logic (cache flags, level, patch shapes) lives in PURE,
// unit-tested modules (memorySignals.ts, quickScanResult.ts, videoMemory.ts).
// This file is the side-effecting glue and is intentionally NOT node-tested
// (it imports the idb-backed store, which needs a browser).
//
// PRIVACY: only compact derived memory is cached/persisted here — NEVER raw
// video bytes or frames.
// =====================================================================

import type { VideoAnalysisMemory, VideoAnalysisMemoryPatch } from "./types";
import {
  getVideoMemoryByHash,
  mergeStoredVideoMemory
} from "./videoMemoryStore";
import { analysisCacheSignals } from "./memorySignals";

/** Synchronous in-memory cache for the current tab session. */
const byHash = new Map<string, VideoAnalysisMemory>();
/** Hashes we've already attempted to load from idb (so we don't refetch a
 *  known-missing memory every turn). */
const primed = new Set<string>();

/** Synchronous read of the cached memory for a hash (null if not loaded). */
export function getCachedVideoMemory(videoHash: string | undefined | null): VideoAnalysisMemory | null {
  if (!videoHash) return null;
  return byHash.get(videoHash) ?? null;
}

/** Budget cache flags for a hash, from the in-memory cache. */
export function cacheSignalsForHash(videoHash: string | undefined | null): {
  hasCachedQuickScan: boolean;
  hasCachedDeepScan: boolean;
  level: number;
} {
  const mem = getCachedVideoMemory(videoHash);
  return { ...analysisCacheSignals(mem), level: mem?.level ?? 0 };
}

/**
 * Load a video's persisted memory into the in-memory cache by hash. Safe to
 * call repeatedly (no-ops after the first load for a given hash unless
 * `force` is set). Returns the memory (or null).
 */
export async function primeVideoMemory(
  videoHash: string | undefined | null,
  opts: { force?: boolean } = {}
): Promise<VideoAnalysisMemory | null> {
  if (!videoHash) return null;
  if (byHash.has(videoHash)) return byHash.get(videoHash)!;
  if (primed.has(videoHash) && !opts.force) return null;
  primed.add(videoHash);
  try {
    const mem = await getVideoMemoryByHash(videoHash);
    if (mem) byHash.set(videoHash, mem);
    return mem;
  } catch {
    return null;
  }
}

export interface VideoMemoryBase {
  videoHash: string;
  sourceId: string;
  sourceName: string;
  durationSeconds: number;
  width?: number;
  height?: number;
}

/**
 * Merge an analysis patch into the stored + in-memory memory for a video.
 * Returns the merged memory (also placed in the sync cache). Persistence is
 * best-effort; the in-memory cache is always updated so the rest of the turn
 * sees the new knowledge even if idb write fails.
 */
export async function recordVideoMemory(
  base: VideoMemoryBase,
  patch: VideoAnalysisMemoryPatch
): Promise<VideoAnalysisMemory> {
  const merged = await mergeStoredVideoMemory(base, patch);
  byHash.set(base.videoHash, merged);
  primed.add(base.videoHash);
  return merged;
}

/** Test/diagnostic hook: clear the in-memory cache (does not touch idb). */
export function __resetVideoMemoryCache(): void {
  byHash.clear();
  primed.clear();
}

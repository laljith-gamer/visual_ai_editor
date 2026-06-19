// =====================================================================
// lib/analysis/videoMemoryStore.ts
//
// Browser persistence for VideoAnalysisMemory (the "VideoMemoryManager").
// Uses idb-keyval (already a dependency) in its OWN store so it never
// collides with the existing session/cache/log databases.
//
// Keyed by `videoHash` so re-uploading the same file reconnects to its
// analysis memory (memory reuse by hash). A tiny sourceId→hash index lets
// callers fetch by the current runtime source id too.
//
// PRIVACY: only compact derived memory is written here — NEVER raw video
// bytes or full frames (see videoMemory.ts). The pure merge/level/summary
// logic lives in videoMemory.ts and is unit-tested; this thin wrapper is
// browser-only I/O.
// =====================================================================

import { get, set, del, createStore } from "idb-keyval";
import type { VideoAnalysisMemory, VideoAnalysisMemoryPatch } from "./types";
import { createVideoMemory, mergeVideoMemory } from "./videoMemory";

const store = createStore("shorts-studio-video-memory", "kv");

const hashKey = (videoHash: string) => `mem:${videoHash}`;
const SOURCE_INDEX_KEY = "sourceIndex";

type SourceIndex = Record<string, string>; // sourceId -> videoHash

async function readSourceIndex(): Promise<SourceIndex> {
  try {
    return (await get<SourceIndex>(SOURCE_INDEX_KEY, store)) ?? {};
  } catch {
    return {};
  }
}

/** Look up the compact memory for a video by its content hash. */
export async function getVideoMemoryByHash(videoHash: string): Promise<VideoAnalysisMemory | null> {
  try {
    return (await get<VideoAnalysisMemory>(hashKey(videoHash), store)) ?? null;
  } catch {
    return null;
  }
}

/** Look up by the current runtime source id (via the sourceId→hash index). */
export async function getVideoMemory(sourceId: string): Promise<VideoAnalysisMemory | null> {
  const index = await readSourceIndex();
  const hash = index[sourceId];
  if (!hash) return null;
  return getVideoMemoryByHash(hash);
}

/** Store/replace a full memory record and keep the sourceId→hash index fresh. */
export async function upsertVideoMemory(memory: VideoAnalysisMemory): Promise<void> {
  try {
    await set(hashKey(memory.videoHash), memory, store);
    const index = await readSourceIndex();
    if (index[memory.sourceId] !== memory.videoHash) {
      index[memory.sourceId] = memory.videoHash;
      await set(SOURCE_INDEX_KEY, index, store);
    }
  } catch {
    // Non-fatal — analysis still works this session without persistence.
  }
}

/**
 * Merge a new analysis pass into the stored memory (by hash), creating a
 * level-0 record first if none exists. Returns the merged result.
 */
export async function mergeStoredVideoMemory(
  base: { videoHash: string; sourceId: string; sourceName: string; durationSeconds: number; width?: number; height?: number },
  patch: VideoAnalysisMemoryPatch
): Promise<VideoAnalysisMemory> {
  const existing = await getVideoMemoryByHash(base.videoHash);
  const old =
    existing ??
    createVideoMemory({
      videoHash: base.videoHash,
      sourceId: base.sourceId,
      sourceName: base.sourceName,
      durationSeconds: base.durationSeconds,
      width: base.width,
      height: base.height
    });
  const merged = mergeVideoMemory(old, { ...patch, updatedAt: Date.now() });
  await upsertVideoMemory(merged);
  return merged;
}

/** Remove a video's memory (e.g. on explicit source delete). */
export async function deleteVideoMemory(videoHash: string, sourceId?: string): Promise<void> {
  try {
    await del(hashKey(videoHash), store);
    if (sourceId) {
      const index = await readSourceIndex();
      if (index[sourceId]) {
        delete index[sourceId];
        await set(SOURCE_INDEX_KEY, index, store);
      }
    }
  } catch {
    // ignore
  }
}

import type { FrameScore, PredictionsCacheEntry } from "@/lib/types";
import { idbCache } from "./idb";
import { CACHE } from "@/lib/config";
import { buildFrameTree, type FrameInput } from "@/lib/frame-tree";
import {
  buildVideoMemoryFromFrameTree,
  saveVideoMemory
} from "@/lib/video-memory";

function key(videoHash: string, signature: string): string {
  return `pred:${videoHash}:${signature}`;
}

export async function getPredictions(
  videoHash: string,
  signature: string
): Promise<PredictionsCacheEntry | undefined> {
  return idbCache.get<PredictionsCacheEntry>(key(videoHash, signature));
}

export async function savePredictions(
  entry: PredictionsCacheEntry
): Promise<void> {
  await idbCache.set(key(entry.videoHash, entry.scenarioSignature), entry);
  await saveVideoMemoryFromPredictions(entry).catch(() => {
    // Memory is a secondary local index. Prediction cache must remain usable
    // even if a browser denies/clears the separate memory database.
  });
}

async function saveVideoMemoryFromPredictions(
  entry: PredictionsCacheEntry
): Promise<void> {
  if (entry.frames.length === 0) return;
  const duration = inferDuration(entry.frames, entry.sampleEverySeconds);
  const treeFrames = entry.frames.map(toFrameInput);
  const frameTree = buildFrameTree(treeFrames, { duration });
  const videoMemory = buildVideoMemoryFromFrameTree(frameTree, {
    videoHash: entry.videoHash,
    duration
  });
  await saveVideoMemory(videoMemory);
}

function toFrameInput(frame: FrameScore): FrameInput {
  return {
    t: frame.t,
    motion: frame.motion ?? 0,
    saliency: frame.saliency ?? frame.score ?? 0
  };
}

function inferDuration(frames: FrameScore[], sampleEverySeconds: number): number {
  const last = frames.reduce((max, frame) => Math.max(max, frame.t), 0);
  return Math.max(last + Math.max(sampleEverySeconds, 0.25), last);
}

/** Trim cache to the most recent N entries to bound IndexedDB usage. */
export async function trimCache(maxEntries: number = CACHE.maxEntries): Promise<void> {
  const keys = (await idbCache.keys()).filter((k): k is string =>
    typeof k === "string" && k.startsWith("pred:")
  );
  if (keys.length <= maxEntries) return;
  const entries = await Promise.all(
    keys.map(async (k) => ({
      k,
      e: await idbCache.get<PredictionsCacheEntry>(k)
    }))
  );
  entries.sort(
    (a, b) => (b.e?.createdAt ?? 0) - (a.e?.createdAt ?? 0)
  );
  for (const old of entries.slice(maxEntries)) {
    await idbCache.del(old.k);
  }
}

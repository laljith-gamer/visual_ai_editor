import type { PredictionsCacheEntry } from "@/lib/types";
import { idbCache } from "./idb";

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
}

/** Trim cache to the most recent N entries to bound IndexedDB usage. */
export async function trimCache(maxEntries = 50): Promise<void> {
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

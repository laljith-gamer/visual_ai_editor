// =====================================================================
// lib/video-memory/store.ts
//
// Browser-side persistence for local video-tree memory. Keyed by video hash
// so the editor can reuse the same understanding across later chats/sessions.
// =====================================================================

import { idbVideoMemory } from "@/lib/store/idb";
import type { VideoMemoryIndex } from "@/lib/video-memory/types";

const KEY_PREFIX = "video-memory:";

export function videoMemoryKey(videoHash: string): string {
  return `${KEY_PREFIX}${videoHash}`;
}

export async function getVideoMemory(
  videoHash: string
): Promise<VideoMemoryIndex | null> {
  const value = await idbVideoMemory.get<VideoMemoryIndex>(videoMemoryKey(videoHash));
  return value ?? null;
}

export async function saveVideoMemory(index: VideoMemoryIndex): Promise<void> {
  await idbVideoMemory.set(videoMemoryKey(index.videoHash), {
    ...index,
    updatedAt: Date.now()
  });
}

export async function deleteVideoMemory(videoHash: string): Promise<void> {
  await idbVideoMemory.del(videoMemoryKey(videoHash));
}

export async function listVideoMemoryKeys(): Promise<string[]> {
  const keys = await idbVideoMemory.keys();
  return keys
    .map(String)
    .filter((key) => key.startsWith(KEY_PREFIX));
}

export async function updateVideoMemoryFeedback(input: {
  videoHash: string;
  nodeId: string;
  accepted?: boolean;
  note?: string;
}): Promise<VideoMemoryIndex | null> {
  const index = await getVideoMemory(input.videoHash);
  if (!index) return null;
  const node = index.nodes[input.nodeId];
  if (!node) return index;

  const now = Date.now();
  if (input.accepted === true) {
    node.feedback.acceptedClipCount += 1;
    node.feedback.lastAcceptedAt = now;
  } else if (input.accepted === false) {
    node.feedback.rejectedClipCount += 1;
    node.feedback.lastRejectedAt = now;
  }
  if (input.note && input.note.trim()) {
    node.feedback.notes = [...node.feedback.notes, input.note.trim()].slice(-12);
  }
  node.updatedAt = now;
  index.updatedAt = now;
  await idbVideoMemory.set(videoMemoryKey(index.videoHash), index);
  return index;
}

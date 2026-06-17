/**
 * Phase 2 (offline) — agent memory persistence.
 *
 * Persists the per-session AgentMemoryStore to IndexedDB (its own
 * `shorts-studio-agent-memory` DB via the self-healing idb layer) so the
 * agent's flow + reinforcement + observed facts survive a page refresh.
 *
 * What IS persisted: the store's `serialize()` output — records
 * (user_stated / observed / flow / source / clip / reinforcement /
 * preference), FlowMemory (selected/active source, last created clips,
 * last operation), and ReinforcementMemory (liked/rejected clips +
 * ranges, source preferences, style hints).
 *
 * What is NOT persisted here (kept lean — no big blobs): raw video bytes,
 * transcript text, or frames. Source metadata + transcript cache live in
 * their own stores (`sessions` / `transcripts`), referenced by id/hash.
 */

import { idbAgentMemory } from "@/lib/store/idb";
import { AgentMemoryStore, type SerializedAgentMemory } from "./store";

const KEY_PREFIX = "agent-memory:";

function keyFor(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}

/** Load a serialized agent memory for a session, or null if none saved. */
export async function loadAgentMemory(sessionId: string): Promise<SerializedAgentMemory | null> {
  if (!sessionId) return null;
  try {
    const data = await idbAgentMemory.get<SerializedAgentMemory>(keyFor(sessionId));
    return data ?? null;
  } catch {
    // Storage unavailable / corrupted — degrade to in-memory only.
    return null;
  }
}

/** Persist a store's current state for a session (fire-and-forget safe). */
export async function saveAgentMemory(sessionId: string, store: AgentMemoryStore): Promise<void> {
  if (!sessionId) return;
  try {
    await idbAgentMemory.set(keyFor(sessionId), store.serialize());
  } catch {
    // Non-fatal: persistence failure must never break editing.
  }
}

/** Clear a session's persisted agent memory. */
export async function clearAgentMemory(sessionId: string): Promise<void> {
  if (!sessionId) return;
  try {
    await idbAgentMemory.del(keyFor(sessionId));
  } catch {
    // ignore
  }
}

/** Hydrate a store from persisted state for a session. Returns true when
 *  something was loaded. */
export async function hydrateAgentMemory(sessionId: string, store: AgentMemoryStore): Promise<boolean> {
  const data = await loadAgentMemory(sessionId);
  if (!data) return false;
  store.hydrate(data);
  return true;
}

// Re-export the pure retrieval helper so callers have one import surface.
export { getRelevantMemory } from "./context";

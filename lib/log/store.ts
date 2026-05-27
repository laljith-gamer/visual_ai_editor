"use client";

import type { ActivityEvent, ActivityActor } from "@/lib/types";
import { ACTIVITY } from "@/lib/config";
import { idbLog } from "@/lib/store/idb";

/**
 * In-memory + IndexedDB-backed activity log. Used by `useActivityLog` and
 * the convenience recorders in `recorders.ts`.
 *
 * Design:
 *   - Events live in memory for fast reads (UI subscriptions).
 *   - Writes are debounced to IndexedDB to avoid disk thrash.
 *   - Consecutive identical events within ACTIVITY.dedupeWindowMs collapse
 *     into one row with a `count` field.
 */

type Listener = (events: ActivityEvent[]) => void;

class ActivityLogStore {
  private events: ActivityEvent[] = [];
  private listeners = new Set<Listener>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private currentSession: string | null = null;
  private dirty = false;

  /** Switch the active session. Loads its persisted events from IDB. */
  async setSession(sessionId: string): Promise<void> {
    if (this.currentSession === sessionId) return;
    await this.flushNow();
    this.currentSession = sessionId;
    const stored = await idbLog.get<ActivityEvent[]>(`log:${sessionId}`);
    this.events = stored ?? [];
    this.notify();
  }

  getSnapshot(): ActivityEvent[] {
    return this.events;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Append an event with dedupe + cap. */
  log(event: ActivityEvent): void {
    if (!this.currentSession || event.sessionId !== this.currentSession) {
      // Lazy session switch when caller knows the session id but we don't yet.
      this.currentSession = event.sessionId;
    }

    const last = this.events[this.events.length - 1];
    if (last && shouldDedupe(last, event)) {
      last.count = (last.count ?? 1) + 1;
      last.ts = event.ts;
      // payload is identical, no-op there
      this.dirty = true;
    } else {
      this.events.push(event);
      if (this.events.length > ACTIVITY.maxEventsPerSession) {
        this.events = this.events.slice(-ACTIVITY.maxEventsPerSession);
      }
      this.dirty = true;
    }
    this.scheduleFlush();
    this.notify();
  }

  /** Clear the in-memory + persisted log for the active session. */
  async clear(): Promise<void> {
    this.events = [];
    this.dirty = false;
    if (this.currentSession) {
      await idbLog.del(`log:${this.currentSession}`);
    }
    this.notify();
  }

  /** Force an immediate flush to IDB and resolve when done. */
  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.currentSession || !this.dirty) return;
    await idbLog.set(`log:${this.currentSession}`, this.events);
    this.dirty = false;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow();
    }, ACTIVITY.flushIntervalMs);
  }

  private notify(): void {
    for (const l of this.listeners) l(this.events);
  }
}

function shouldDedupe(a: ActivityEvent, b: ActivityEvent): boolean {
  if (a.actor !== b.actor || a.kind !== b.kind) return false;
  if (b.ts - a.ts > ACTIVITY.dedupeWindowMs) return false;
  // payload-equality check (cheap; payloads are small)
  return JSON.stringify(a.payload) === JSON.stringify(b.payload);
}

/** Singleton instance, scoped to the running tab. */
export const activityLogStore = new ActivityLogStore();

/** Convenience helper used by `summarizeRecentActivity`. */
export function getRecentEvents(
  maxCount = ACTIVITY.recentForPlanner,
  actorFilter?: ActivityActor
): ActivityEvent[] {
  const all = activityLogStore.getSnapshot();
  const now = Date.now();
  const fresh = all.filter((e) => now - e.ts <= ACTIVITY.recentMaxAgeMs);
  const filtered = actorFilter ? fresh.filter((e) => e.actor === actorFilter) : fresh;
  return filtered.slice(-maxCount);
}

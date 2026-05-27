"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { ActivityEvent } from "@/lib/types";
import { activityLogStore } from "@/lib/log/store";

/**
 * Subscribe to the singleton activity log and re-render on every
 * append. Use the `sessionId` argument (typically `useEditorStore.sessionId`)
 * so the store knows which IDB key to load on mount and on session changes.
 */
export function useActivityLog(sessionId: string | null): ActivityEvent[] {
  // Bind the store to the active session.
  useEffect(() => {
    if (!sessionId) return;
    void activityLogStore.setSession(sessionId);
  }, [sessionId]);

  return useSyncExternalStore(
    activityLogStore.subscribe.bind(activityLogStore),
    () => activityLogStore.getSnapshot(),
    () => [] // SSR snapshot
  );
}

/** Imperative clear from the drawer's "Clear log" button. */
export async function clearActivityLog(): Promise<void> {
  await activityLogStore.clear();
}

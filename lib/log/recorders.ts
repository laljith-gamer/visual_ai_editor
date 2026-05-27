"use client";

import type { ActivityEvent } from "@/lib/types";
import { activityLogStore } from "./store";
import { newId } from "@/lib/util/id";

interface RecorderInput {
  sessionId: string;
  kind: string;
  payload?: Record<string, unknown>;
  ms?: number;
  summary?: string;
}

function record(actor: ActivityEvent["actor"], input: RecorderInput): void {
  if (typeof window === "undefined") return; // SSR no-op
  const event: ActivityEvent = {
    id: newId("ev"),
    sessionId: input.sessionId,
    ts: Date.now(),
    actor,
    kind: input.kind,
    payload: input.payload ?? {},
    ms: input.ms,
    summary: input.summary
  };
  activityLogStore.log(event);
}

/** Log a user-initiated event. */
export function logUser(input: RecorderInput): void {
  record("user", input);
}

/** Log an AI / pipeline event. */
export function logAi(input: RecorderInput): void {
  record("ai", input);
}

/** Log a system / operational event. */
export function logSystem(input: RecorderInput): void {
  record("system", input);
}

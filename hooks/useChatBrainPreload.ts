"use client";

// =====================================================================
// hooks/useChatBrainPreload.ts
//
// Starts the background Chat Brain warmup AFTER the editor mounts (and again
// when the first upload begins), using requestIdleCallback where available so
// it never competes with first paint or the user's first interaction. Exposes
// the live status for a small, non-blocking UI badge.
//
// It is intentionally fire-and-forget: the warmup promise is never awaited on
// the render path, and a failure just leaves the app in deterministic mode.
// =====================================================================

import { useEffect, useState } from "react";
import { CHAT_BRAIN } from "@/lib/config";
import {
  getChatBrainStatus,
  preloadChatBrain,
  subscribeChatBrain,
  type ChatBrainStatus
} from "@/lib/llm/chatBrainPreload";

type IdleHandle = number;
function scheduleIdle(fn: () => void, delayMs: number): () => void {
  if (typeof window === "undefined") return () => {};
  const ric = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => IdleHandle;
  }).requestIdleCallback;
  const cic = (window as unknown as {
    cancelIdleCallback?: (h: IdleHandle) => void;
  }).cancelIdleCallback;

  const timer = window.setTimeout(() => {
    if (ric) {
      const handle = ric(fn, { timeout: 2000 });
      cleanup = () => cic?.(handle);
    } else {
      fn();
    }
  }, delayMs);
  let cleanup = () => window.clearTimeout(timer);
  return () => cleanup();
}

export interface UseChatBrainPreload {
  status: ChatBrainStatus;
  /** Manually (re)trigger the warmup, e.g. when an upload begins. */
  trigger: () => void;
}

/**
 * @param opts.uploadStarted  flip to true when the first upload begins so the
 *        warmup can start (or re-confirm) without waiting for a chat turn.
 */
export function useChatBrainPreload(opts: { uploadStarted?: boolean } = {}): UseChatBrainPreload {
  const [status, setStatus] = useState<ChatBrainStatus>(() => getChatBrainStatus());

  // Keep local state in sync with the module singleton.
  useEffect(() => subscribeChatBrain(setStatus), []);

  // Warm up shortly after mount (idle-time), if enabled.
  useEffect(() => {
    if (!CHAT_BRAIN.preloadEnabled || !CHAT_BRAIN.preloadOnEditorMount) return;
    return scheduleIdle(() => void preloadChatBrain(), CHAT_BRAIN.preloadDelayMs);
  }, []);

  // Warm up when the first upload begins (idempotent — no-op if already done).
  useEffect(() => {
    if (!CHAT_BRAIN.preloadEnabled || !CHAT_BRAIN.preloadOnUploadStart) return;
    if (!opts.uploadStarted) return;
    void preloadChatBrain();
  }, [opts.uploadStarted]);

  return { status, trigger: () => void preloadChatBrain() };
}

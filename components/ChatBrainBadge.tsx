"use client";

// =====================================================================
// components/ChatBrainBadge.tsx
//
// A tiny, non-blocking status pill for the Chat Brain warmup. It is
// intentionally quiet: only shows "warming" / "ready" while interesting,
// and "Local mode" when no text brain is available (deterministic-only).
// It subscribes to the module-level status singleton, so it costs nothing
// until the status changes.
// =====================================================================

import { useEffect, useState } from "react";
import { Brain } from "lucide-react";
import {
  getChatBrainStatus,
  subscribeChatBrain,
  type ChatBrainStatus
} from "@/lib/llm/chatBrainPreload";

const LABEL: Record<ChatBrainStatus, string | null> = {
  idle: null,
  warming: "Chat brain warming\u2026",
  ready: "Chat brain ready",
  unavailable: "Local mode",
  failed: "Local mode"
};

const COLOR: Record<ChatBrainStatus, string> = {
  idle: "#94a3b8",
  warming: "#f59e0b",
  ready: "#22c55e",
  unavailable: "#94a3b8",
  failed: "#94a3b8"
};

export function ChatBrainBadge() {
  const [status, setStatus] = useState<ChatBrainStatus>(() => getChatBrainStatus());
  useEffect(() => subscribeChatBrain(setStatus), []);

  const label = LABEL[status];
  if (!label) return null;

  return (
    <span
      title={
        status === "ready"
          ? "Free-text understanding is warmed and ready"
          : status === "warming"
            ? "Warming the text-only chat brain in the background"
            : "No cloud text brain \u2014 using fast on-device deterministic understanding"
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 11,
        lineHeight: 1,
        padding: "3px 7px",
        borderRadius: 999,
        color: COLOR[status],
        border: `1px solid ${COLOR[status]}33`,
        background: `${COLOR[status]}14`,
        whiteSpace: "nowrap"
      }}
    >
      <Brain size={11} aria-hidden />
      {label}
    </span>
  );
}

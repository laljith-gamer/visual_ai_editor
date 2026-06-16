"use client";

import { Cpu, PencilRuler, Loader2 } from "lucide-react";
import { LOCAL_LLM } from "@/lib/local-llm/config";
import { useLocalAIStatus } from "@/lib/local-llm/status";

/**
 * AIModeBadge — small chat-header pill showing the active planner path.
 * In local-only mode, never show Cloud AI even before WebLLM has loaded.
 */
export function AIModeBadge() {
  const status = useLocalAIStatus();

  const show = LOCAL_LLM.enabled || LOCAL_LLM.localOnly || status.mode !== "cloud";
  if (!show) return null;

  if (status.phase === "loading") {
    const pct = Math.round((status.progress || 0) * 100);
    return (
      <span
        className="pill info"
        title={status.text || "Local AI loading"}
        aria-live="polite"
      >
        <Loader2 size={12} className="spin" /> Local AI loading{pct > 0 ? ` ${pct}%` : "…"}
      </span>
    );
  }

  if (LOCAL_LLM.localOnly || status.mode === "local") {
    return (
      <span className="pill accent" title="Local-only mode: planning on-device when available; no cloud model calls">
        <Cpu size={12} /> Local AI
      </span>
    );
  }

  if (status.mode === "manual") {
    return (
      <span className="pill" title="AI is unavailable — the editor still works manually (upload, trim, render)">
        <PencilRuler size={12} /> Manual
      </span>
    );
  }

  return null;
}

"use client";

import { Cloud, Cpu, PencilRuler, Loader2 } from "lucide-react";
import { LOCAL_LLM } from "@/lib/local-llm/config";
import { useLocalAIStatus } from "@/lib/local-llm/status";

/**
 * AIModeBadge — a small pill in the chat header showing which planner
 * path is active: Cloud (primary), Local (on-device WebLLM fallback), or
 * Manual (no AI available — the editor still works by hand). While the
 * local engine downloads/compiles it shows "Local AI loading… NN%".
 *
 * Rendered ONLY when the local-LLM feature is enabled OR a non-cloud mode
 * is active, so it never clutters the default cloud-only experience and
 * doesn't duplicate <CapabilityBadge/> (which reflects the VISION tier).
 *
 * This component subscribes to the lightweight status store; it does NOT
 * import or trigger WebLLM, so mounting it never loads the model.
 */
export function AIModeBadge() {
  const status = useLocalAIStatus();

  const show = LOCAL_LLM.enabled || status.mode !== "cloud";
  if (!show) return null;

  if (status.phase === "loading") {
    const pct = Math.round((status.progress || 0) * 100);
    return (
      <span
        className="pill info"
        title={status.text || "Local AI loading"}
        aria-live="polite"
      >
        <Loader2 size={12} className="spin" /> Local AI loading{pct > 0 ? ` ${pct}%` : "\u2026"}
      </span>
    );
  }

  if (status.mode === "local") {
    return (
      <span className="pill accent" title="Planning on-device with local AI (text only \u2014 no video vision)">
        <Cpu size={12} /> Local AI
      </span>
    );
  }

  if (status.mode === "manual") {
    return (
      <span className="pill" title="AI is unavailable \u2014 the editor still works manually (upload, trim, render)">
        <PencilRuler size={12} /> Manual
      </span>
    );
  }

  return (
    <span className="pill" title="Using the cloud planner">
      <Cloud size={12} /> Cloud AI
    </span>
  );
}

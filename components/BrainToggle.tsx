"use client";

// =====================================================================
// components/BrainToggle.tsx
//
// A small segmented control in the chat header to choose the AI brain:
//   OpenRouter (cloud)  ↔  Local (on-device WebLLM)
//
// BOTH options are always selectable — the user is never blocked from
// toggling. We probe /api/agent/intent (warmup) only to show a hint when
// OpenRouter isn't configured yet; if it's selected but unreachable, the
// planner falls back to on-device and says so. The choice is read by the
// planner from lib/ai/brainPreference.
// =====================================================================

import { useEffect, useState } from "react";
import { Cloud, Cpu } from "lucide-react";
import { setAIBrain, useAIBrain } from "@/lib/ai/brainPreference";
import styles from "./BrainToggle.module.css";

export function BrainToggle() {
  const brain = useAIBrain();
  // Diagnostic from /api/agent/intent status: configured + the specific reason.
  const [diag, setDiag] = useState<{
    configured: boolean;
    cloudEnabled?: boolean;
    hasProviderKey?: boolean;
    checked: boolean;
  }>({ configured: false, checked: false });

  useEffect(() => {
    let alive = true;
    fetch("/api/agent/intent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "status" })
    })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (d: {
          configured?: boolean;
          cloudEnabled?: boolean;
          hasProviderKey?: boolean;
        } | null) => {
          if (!alive) return;
          setDiag({
            configured: Boolean(d?.configured),
            cloudEnabled: d?.cloudEnabled,
            hasProviderKey: d?.hasProviderKey,
            checked: true
          });
        }
      )
      .catch(() => {
        if (alive) setDiag({ configured: false, checked: true });
      });
    return () => {
      alive = false;
    };
  }, []);

  const cloudReady = diag.configured;
  const cloudUnconfigured = brain === "cloud" && diag.checked && !cloudReady;

  // Specific, actionable reason for the tooltip when not configured.
  const cloudReason = cloudReady
    ? "OpenRouter — plan with the cloud model"
    : !diag.checked
      ? "Checking OpenRouter availability\u2026"
      : diag.cloudEnabled === false
        ? "OpenRouter off: set DISABLE_CLOUD_AI=false in your deploy env and redeploy."
        : diag.hasProviderKey === false
          ? "No API key found: set OPENROUTER_API_KEY in your deploy env and redeploy."
          : "OpenRouter isn\u2019t reachable on this deployment yet (it falls back to Local).";

  return (
    <div className={styles.toggle} role="group" aria-label="AI brain">
      <button
        type="button"
        className={`${styles.seg} ${brain === "cloud" ? styles.active : ""}`}
        onClick={() => setAIBrain("cloud")}
        aria-pressed={brain === "cloud"}
        title={cloudReason}
      >
        <Cloud size={12} aria-hidden /> OpenRouter
        {cloudUnconfigured && (
          <span className={styles.warnDot} aria-hidden title={cloudReason}>
            !
          </span>
        )}
      </button>
      <button
        type="button"
        className={`${styles.seg} ${brain === "local" ? styles.active : ""}`}
        onClick={() => setAIBrain("local")}
        aria-pressed={brain === "local"}
        title="Local — plan on-device with WebLLM (private, no cloud)"
      >
        <Cpu size={12} aria-hidden /> Local
      </button>
    </div>
  );
}

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
  // null = still checking; true/false = configured or not.
  const [cloudReady, setCloudReady] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/agent/intent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "status" })
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { configured?: boolean } | null) => {
        if (alive) setCloudReady(Boolean(d?.configured));
      })
      .catch(() => {
        if (alive) setCloudReady(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const cloudUnconfigured = brain === "cloud" && cloudReady === false;

  return (
    <div className={styles.toggle} role="group" aria-label="AI brain">
      <button
        type="button"
        className={`${styles.seg} ${brain === "cloud" ? styles.active : ""}`}
        onClick={() => setAIBrain("cloud")}
        aria-pressed={brain === "cloud"}
        title={
          cloudReady === true
            ? "OpenRouter — plan with the cloud model"
            : "OpenRouter — set OPENROUTER_API_KEY + DISABLE_CLOUD_AI=false to enable. Until then it falls back to Local."
        }
      >
        <Cloud size={12} aria-hidden /> OpenRouter
        {cloudUnconfigured && (
          <span className={styles.warnDot} aria-hidden title="Not configured yet">
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

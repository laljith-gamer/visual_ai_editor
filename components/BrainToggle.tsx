"use client";

// =====================================================================
// components/BrainToggle.tsx
//
// A small segmented control in the chat header to choose the AI brain:
//   Kiro (cloud Claude)  ↔  Local (on-device WebLLM)
//
// "Kiro" is only selectable when the server reports a cloud provider is
// configured (a /api/agent/intent warmup returns {status:"ready"} — which
// requires DISABLE_CLOUD_AI=false + an API key). Otherwise it is shown
// disabled with a tooltip explaining how to enable it, and the choice falls
// back to Local. The planner reads the choice from lib/ai/brainPreference.
// =====================================================================

import { useEffect, useState } from "react";
import { Cloud, Cpu } from "lucide-react";
import { getAIBrain, setAIBrain, useAIBrain } from "@/lib/ai/brainPreference";
import styles from "./BrainToggle.module.css";

export function BrainToggle() {
  const brain = useAIBrain();
  const [cloudReady, setCloudReady] = useState(false);

  // Detect whether a cloud brain is actually configured on this deployment.
  // The warmup is cheap and returns "ready" only when a provider + key exist.
  useEffect(() => {
    let alive = true;
    fetch("/api/agent/intent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "warmup" })
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { status?: string } | null) => {
        if (alive) setCloudReady(d?.status === "ready");
      })
      .catch(() => {
        /* offline / no provider → stays local-only */
      });
    return () => {
      alive = false;
    };
  }, []);

  // If cloud was selected but isn't (or is no longer) available, fall back.
  useEffect(() => {
    if (!cloudReady && getAIBrain() === "cloud") setAIBrain("local");
  }, [cloudReady]);

  return (
    <div className={styles.toggle} role="group" aria-label="AI brain">
      <button
        type="button"
        className={`${styles.seg} ${brain === "cloud" ? styles.active : ""}`}
        onClick={() => cloudReady && setAIBrain("cloud")}
        disabled={!cloudReady}
        aria-pressed={brain === "cloud"}
        title={
          cloudReady
            ? "Kiro — plan with the cloud model (Claude)"
            : "Kiro is unavailable here. Set your API key and DISABLE_CLOUD_AI=false to enable."
        }
      >
        <Cloud size={12} aria-hidden /> Kiro
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

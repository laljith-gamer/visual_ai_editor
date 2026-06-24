"use client";

// =====================================================================
// components/AnalysisModeToggle.tsx
//
// Compact single-button toggle for the cloud-analysis switch. It controls
// WHERE the heavy media passes (scene analysis + transcription) run:
//
//   OFF (default) → fully on-device (SigLIP + Whisper). Private, offline.
//   ON            → free OpenRouter analysis model. Faster, needs a key.
//
// On-device always remains the guaranteed fallback, so flipping this never
// breaks editing — it only changes speed / where compute happens. Reads and
// writes the single source of truth in lib/ai/cloudAnalysisPreference.
// =====================================================================

import { Cpu, Zap } from "lucide-react";
import { setCloudAnalysis, useCloudAnalysis } from "@/lib/ai/cloudAnalysisPreference";
import styles from "./AnalysisModeToggle.module.css";

export function AnalysisModeToggle() {
  const cloud = useCloudAnalysis();
  return (
    <button
      type="button"
      className={`${styles.btn} ${cloud ? styles.cloud : ""}`}
      onClick={() => setCloudAnalysis(!cloud)}
      aria-pressed={cloud}
      title={
        cloud
          ? "Fast analysis: scene + transcription run on a free OpenRouter model (needs a key; falls back to on-device). Click to go fully offline."
          : "On-device analysis: scene + transcription run locally (private, offline). Click to use the faster cloud model."
      }
    >
      {cloud ? <Zap size={13} aria-hidden /> : <Cpu size={13} aria-hidden />}
      <span>{cloud ? "Fast" : "Local"}</span>
    </button>
  );
}

"use client";

import { Sparkles, Plus } from "lucide-react";
import { useEditorStore } from "@/hooks/useEditorStore";
import { formatTime } from "@/lib/util/time";
import { ModeBadge } from "./ModeBadge";
import styles from "./Topbar.module.css";

export function Topbar() {
  const status = useEditorStore((s) => s.status);
  const highlights = useEditorStore((s) => s.highlights);
  const plan = useEditorStore((s) => s.plan);
  const mode = useEditorStore((s) => s.mode);
  const inferred = useEditorStore((s) => s.inferred);
  const newSession = useEditorStore((s) => s.newSession);

  const totalDuration = highlights.reduce(
    (acc, h) => acc + (h.end - h.start),
    0
  );
  const sampleCount = plan
    ? Math.floor((plan.targetShortSeconds * 4) / plan.sampleEverySeconds)
    : 0;

  return (
    <header className={styles.topbar}>
      <div className={styles.brand}>
        <div className={styles.brandMark}>
          <Sparkles size={18} />
        </div>
        <div>
          <p className="eyebrow">Universal Video Shorts Editor</p>
          <h1>Shorts Studio</h1>
        </div>
      </div>

      <div className={styles.actions}>
        <button className="btn" onClick={newSession}>
          <Plus size={14} />
          New chat
        </button>
        <ModeBadge mode={mode} />
        {inferred.length > 0 && (
          <span
            className="pill info"
            title={inferred.map((f) => `${f.field}: ${f.reason}`).join("\n")}
          >
            {inferred.length} inferred
          </span>
        )}
        {sampleCount > 0 && <span className="pill">{sampleCount} samples</span>}
        {totalDuration > 0 && (
          <span className="pill accent">
            {formatTime(totalDuration)} selected
          </span>
        )}
        <span className={`pill ${statusToClass(status)}`}>
          {labelStatus(status)}
        </span>
      </div>
    </header>
  );
}

function statusToClass(s: string): string {
  if (s === "completed" || s === "ready") return "accent";
  if (s === "failed") return "warn";
  if (s === "idle") return "";
  return "info";
}
function labelStatus(s: string): string {
  return (
    {
      idle: "ready to plan",
      planning: "planning",
      sampling: "sampling frames",
      scoring: "scoring frames",
      temporal: "judging windows",
      selecting: "picking clips",
      ready: "ready to render",
      rendering: "rendering",
      completed: "done",
      failed: "failed"
    }[s] ?? s
  );
}

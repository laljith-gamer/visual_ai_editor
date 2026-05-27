"use client";

import { Sparkles, Plus, Activity as ActivityIcon } from "lucide-react";
import { useEditorStore } from "@/hooks/useEditorStore";
import { useActivityLog } from "@/hooks/useActivityLog";
import { logUser } from "@/lib/log/recorders";
import { formatTime } from "@/lib/util/time";
import { ModeBadge } from "./ModeBadge";
import styles from "./Topbar.module.css";

interface Props {
  /** Open the activity drawer. Owned by app/page.tsx. */
  onOpenActivity: () => void;
  /** Number of new events since the user last opened the drawer. */
  newActivityCount?: number;
}

export function Topbar({ onOpenActivity, newActivityCount = 0 }: Props) {
  const status = useEditorStore((s) => s.status);
  const highlights = useEditorStore((s) => s.highlights);
  const plan = useEditorStore((s) => s.plan);
  const mode = useEditorStore((s) => s.mode);
  const inferred = useEditorStore((s) => s.inferred);
  const newSession = useEditorStore((s) => s.newSession);
  const sessionId = useEditorStore((s) => s.sessionId);

  // Make sure the activity log stays bound even on this lightweight component;
  // the read is cheap and ensures the singleton is initialized for the active session.
  useActivityLog(sessionId);

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
        <button
          className="btn"
          onClick={() => {
            logUser({
              sessionId,
              kind: "session.reset",
              payload: {},
              summary: "Started a new chat (state reset)"
            });
            newSession();
          }}
        >
          <Plus size={14} />
          New chat
        </button>

        <button
          className="btn"
          onClick={onOpenActivity}
          aria-label="Open activity log"
          title="Activity log"
          style={{ position: "relative" }}
        >
          <ActivityIcon size={14} />
          Activity
          {newActivityCount > 0 && (
            <span
              aria-hidden
              style={{
                position: "absolute",
                top: 4,
                right: 6,
                width: 8,
                height: 8,
                borderRadius: 999,
                background: "var(--accent)",
                boxShadow: "0 0 0 2px var(--bg-2)"
              }}
            />
          )}
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

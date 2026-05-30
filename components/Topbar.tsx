"use client";

import { useEffect, useState } from "react";
import {
  Sparkles,
  Plus,
  Activity as ActivityIcon,
  FileText,
  Moon,
  Sun
} from "lucide-react";
import { useEditorStore } from "@/hooks/useEditorStore";
import { useActivityLog } from "@/hooks/useActivityLog";
import { logUser } from "@/lib/log/recorders";
import { formatTime } from "@/lib/util/time";
import { ModeBadge } from "./ModeBadge";
import styles from "./Topbar.module.css";

interface Props {
  /** Open the activity drawer. Owned by app/editor/page.tsx. */
  onOpenActivity: () => void;
  /** Number of new events since the user last opened the drawer. */
  newActivityCount?: number;
  /** v1.7.3 — Open the transcript drawer. Optional so callers that
   *  don't render TranscriptDrawer (none today, but future surfaces
   *  like a mobile-only layout) can omit. */
  onOpenTranscript?: () => void;
  /** v1.7.3 — Whether transcription is supported on this device. The
   *  button is hidden when false (low-tier devices / no Web Audio). */
  transcriptEnabled?: boolean;
}

type ThemeMode = "dark" | "light";

const THEME_STORAGE_KEY = "shorts-studio.theme";

export function Topbar({
  onOpenActivity,
  newActivityCount = 0,
  onOpenTranscript,
  transcriptEnabled
}: Props) {
  const status = useEditorStore((s) => s.status);
  const highlights = useEditorStore((s) => s.highlights);
  const plan = useEditorStore((s) => s.plan);
  const mode = useEditorStore((s) => s.mode);
  const inferred = useEditorStore((s) => s.inferred);
  const newSession = useEditorStore((s) => s.newSession);
  const sessionId = useEditorStore((s) => s.sessionId);
  const [theme, setTheme] = useState<ThemeMode>("dark");

  // Make sure the activity log stays bound even on this lightweight component;
  // the read is cheap and ensures the singleton is initialized for the active session.
  useActivityLog(sessionId);

  useEffect(() => {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "dark" || saved === "light") {
      setTheme(saved);
      return;
    }
    const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)").matches;
    setTheme(prefersLight ? "light" : "dark");
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const totalDuration = highlights.reduce(
    (acc, h) => acc + (h.end - h.start),
    0
  );
  const sampleCount = plan
    ? Math.floor((plan.targetShortSeconds * 4) / plan.sampleEverySeconds)
    : 0;
  const nextTheme = theme === "dark" ? "light" : "dark";

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
          className={styles.newChatBtn}
          onClick={() => {
            logUser({
              sessionId,
              kind: "session.reset",
              payload: {},
              summary: "Started a new chat (state reset)"
            });
            newSession();
          }}
          title="Clear the conversation and start fresh"
        >
          <Plus size={14} strokeWidth={2.5} />
          <span>New chat</span>
        </button>

        <button
          className={styles.iconBtn}
          onClick={() => setTheme(nextTheme)}
          aria-label={`Switch to ${nextTheme} mode`}
          title={`Switch to ${nextTheme} mode`}
        >
          {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
          <span className={styles.iconBtnLabel}>
            {theme === "dark" ? "Light" : "Dark"}
          </span>
        </button>

        <button
          className={styles.iconBtn}
          onClick={onOpenActivity}
          aria-label="Open activity log"
          title="Activity log"
        >
          <ActivityIcon size={14} />
          <span className={styles.iconBtnLabel}>Activity</span>
          {newActivityCount > 0 && (
            <span aria-hidden className={styles.activityDot} />
          )}
        </button>

        {onOpenTranscript && transcriptEnabled !== false && (
          <button
            className={styles.iconBtn}
            onClick={onOpenTranscript}
            aria-label="Open transcript"
            title="Transcript"
          >
            <FileText size={14} />
            <span className={styles.iconBtnLabel}>Transcript</span>
          </button>
        )}

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

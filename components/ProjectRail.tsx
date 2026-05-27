"use client";

import { useEffect, useRef } from "react";
import { Upload, Trash2, History as HistoryIcon } from "lucide-react";
import { useEditorStore } from "@/hooks/useEditorStore";
import { sha256Blob } from "@/lib/util/hash";
import { probeVideo } from "@/lib/pipeline/sample";
import { formatTime } from "@/lib/util/time";
import styles from "./ProjectRail.module.css";

export function ProjectRail() {
  const fileRef = useRef<HTMLInputElement>(null);
  const videoMeta = useEditorStore((s) => s.videoMeta);
  const setVideo = useEditorStore((s) => s.setVideo);
  const clearVideo = useEditorStore((s) => s.clearVideo);
  const status = useEditorStore((s) => s.status);
  const progress = useEditorStore((s) => s.progress);
  const statusDetail = useEditorStore((s) => s.statusDetail);
  const memory = useEditorStore((s) => s.memory);
  const history = useEditorStore((s) => s.history);
  const refreshHistory = useEditorStore((s) => s.refreshHistory);
  const restoreSession = useEditorStore((s) => s.restoreSession);
  const removeSession = useEditorStore((s) => s.removeSession);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  async function handleFile(file: File) {
    try {
      const probe = await probeVideo(file);
      const hash = await sha256Blob(file);
      setVideo(file, {
        name: file.name,
        size: file.size,
        duration: probe.duration,
        width: probe.width,
        height: probe.height
      }, hash);
    } catch (err) {
      console.error("Failed to load video", err);
      alert(`Couldn't read this video: ${(err as Error).message}`);
    }
  }

  return (
    <aside className={`rail ${styles.rail}`}>
      <div className="card">
        <div className="card-header">Source</div>
        <div className="card-body">
          {videoMeta ? (
            <div className={styles.fileSummary}>
              <p className={styles.fileName}>{videoMeta.name}</p>
              <p className="faint">
                {formatTime(videoMeta.duration)} · {videoMeta.width}×{videoMeta.height} ·{" "}
                {(videoMeta.size / 1024 / 1024).toFixed(1)} MB
              </p>
              <button className="btn danger" onClick={clearVideo}>
                <Trash2 size={14} /> Remove
              </button>
            </div>
          ) : (
            <button
              className={`btn primary ${styles.uploadBtn}`}
              onClick={() => fileRef.current?.click()}
            >
              <Upload size={14} /> Upload video
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="video/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.currentTarget.value = "";
            }}
          />
        </div>
      </div>

      <div className="card">
        <div className="card-header">Progress</div>
        <div className="card-body">
          <div className={styles.progressNum}>
            {Math.round(progress * 100)}
            <span className={styles.progressUnit}>%</span>
          </div>
          <div className={styles.progressMeter}>
            <div
              className={styles.progressFill}
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <p className="faint">{statusDetail ?? labelStatus(status)}</p>
        </div>
      </div>

      <div className="card">
        <div className="card-header">Memory</div>
        <div className="card-body">
          <div className={styles.memoryTags}>
            {memory.duration && <span className="pill">{memory.duration}s</span>}
            {memory.format && <span className="pill">{memory.format}</span>}
            {memory.styles.map((s) => (
              <span key={s} className="pill info">{s}</span>
            ))}
            {memory.skip.map((s) => (
              <span key={s} className="pill warn">avoid: {s}</span>
            ))}
            {memory.duration === undefined &&
              memory.format === undefined &&
              memory.styles.length === 0 &&
              memory.skip.length === 0 && (
                <p className="faint">No preferences yet — start a chat.</p>
              )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <HistoryIcon size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
          History
        </div>
        <div className="card-body">
          {history.length === 0 ? (
            <p className="faint">Past sessions show up here.</p>
          ) : (
            <ul className={styles.historyList}>
              {history.slice(0, 8).map((h) => (
                <li key={h.id} className={styles.historyItem}>
                  <button
                    className={styles.historyButton}
                    onClick={() => void restoreSession(h.id)}
                  >
                    <span className={styles.historyTitle}>{h.title}</span>
                    <span className="faint">{new Date(h.updatedAt).toLocaleString()}</span>
                  </button>
                  <button
                    className="btn icon danger"
                    aria-label="Delete session"
                    onClick={() => void removeSession(h.id)}
                  >
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </aside>
  );
}

function labelStatus(s: string): string {
  if (s === "idle") return "Idle";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

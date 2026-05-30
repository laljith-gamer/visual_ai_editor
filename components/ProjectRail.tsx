"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  Upload,
  Plus,
  Trash2,
  History as HistoryIcon,
  Film
} from "lucide-react";
import { useEditorStore } from "@/hooks/useEditorStore";
import { sha256Blob } from "@/lib/util/hash";
import { probeVideo } from "@/lib/pipeline/sample";
import { formatTime } from "@/lib/util/time";
import { logUser } from "@/lib/log/recorders";
import { LIBRARY_LIMITS, SOURCE_COLORS } from "@/lib/config";
import styles from "./ProjectRail.module.css";

export function ProjectRail() {
  const fileRef = useRef<HTMLInputElement>(null);
  const sources = useEditorStore((s) => s.sources);
  const activeSourceId = useEditorStore((s) => s.activeSourceId);
  const selectedSourceIds = useEditorStore((s) => s.selectedSourceIds);
  const addSource = useEditorStore((s) => s.addSource);
  const removeSource = useEditorStore((s) => s.removeSource);
  const setActiveSource = useEditorStore((s) => s.setActiveSource);
  const toggleSourceSelection = useEditorStore((s) => s.toggleSourceSelection);
  const selectAllSources = useEditorStore((s) => s.selectAllSources);
  const selectActiveOnlySource = useEditorStore((s) => s.selectActiveOnlySource);
  const status = useEditorStore((s) => s.status);
  const progress = useEditorStore((s) => s.progress);
  const statusDetail = useEditorStore((s) => s.statusDetail);
  const memory = useEditorStore((s) => s.memory);
  const history = useEditorStore((s) => s.history);
  const sessionId = useEditorStore((s) => s.sessionId);
  const refreshHistory = useEditorStore((s) => s.refreshHistory);
  const restoreSession = useEditorStore((s) => s.restoreSession);
  const removeSession = useEditorStore((s) => s.removeSession);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  const totalBytes = useMemo(
    () => sources.reduce((acc, s) => acc + s.meta.size, 0),
    [sources]
  );
  const atCountCap = sources.length >= LIBRARY_LIMITS.maxCount;
  const atByteCap = totalBytes >= LIBRARY_LIMITS.maxTotalBytes;

  async function handleFiles(fileList: FileList) {
    const files = Array.from(fileList);
    for (const file of files) {
      // Per-source size guard. Friendly error rather than "Failed to fetch".
      if (file.size > LIBRARY_LIMITS.maxSingleBytes) {
        alert(
          `"${file.name}" is ${(file.size / 1024 / 1024).toFixed(0)} MB — ` +
            `larger than the per-file limit of ${Math.round(
              LIBRARY_LIMITS.maxSingleBytes / 1024 / 1024
            )} MB. Try a shorter clip or a lower-resolution export.`
        );
        continue;
      }
      try {
        const probe = await probeVideo(file);
        const hash = await sha256Blob(file);
        const added = addSource(
          file,
          {
            name: file.name,
            size: file.size,
            duration: probe.duration,
            width: probe.width,
            height: probe.height
          },
          hash
        );
        if (!added) {
          alert(
            "Library is full — remove a video before adding another, " +
              "or open a new session."
          );
          break;
        }
        logUser({
          sessionId,
          kind: "video.uploaded",
          payload: {
            sourceId: added.id,
            name: file.name,
            sizeBytes: file.size,
            durationSeconds: Math.round(probe.duration),
            width: probe.width,
            height: probe.height
          },
          summary: `Added "${file.name}" (${Math.round(probe.duration)}s, ${probe.width}×${probe.height})`
        });
      } catch (err) {
        console.error("Failed to load video", err);
        alert(`Couldn't read "${file.name}": ${(err as Error).message}`);
      }
    }
  }

  function handleRemoveSource(id: string, name: string) {
    logUser({
      sessionId,
      kind: "video.removed",
      payload: { sourceId: id, name },
      summary: `Removed "${name}" from library`
    });
    removeSource(id);
  }

  return (
    <aside className={`rail ${styles.rail}`}>
      {/* ─── Library card ──────────────────────────────────────────── */}
      <div className={`card ${styles.libraryCard}`}>
        <div className="card-header">
          <div className={styles.libraryHeader}>
            <Film size={14} />
            <span>Library</span>
            <span className="muted mono" style={{ fontSize: 11 }}>
              {sources.length}/{LIBRARY_LIMITS.maxCount}
            </span>
            {sources.length > 1 && (
              <div className={styles.libraryActions}>
                <button
                  className={styles.libraryActionBtn}
                  onClick={() => selectAllSources()}
                  title="Use every video in the library for the next AI run"
                >
                  All
                </button>
                <button
                  className={styles.libraryActionBtn}
                  onClick={() => selectActiveOnlySource()}
                  title="Only use the currently-active video for the next AI run"
                >
                  Active only
                </button>
              </div>
            )}
          </div>
        </div>
        <div className={`card-body ${styles.libraryBody}`}>
          {sources.length === 0 ? (
            <button
              className={`btn primary ${styles.uploadBtn}`}
              onClick={() => fileRef.current?.click()}
            >
              <Upload size={14} /> Upload videos
            </button>
          ) : (
            <div className={styles.libraryLoaded}>
              <ul className={styles.libraryList}>
                {sources.map((s, i) => {
                  const color = SOURCE_COLORS[i % SOURCE_COLORS.length];
                  const isActive = activeSourceId === s.id;
                  const isSelected = selectedSourceIds.includes(s.id);
                  return (
                    <li
                      key={s.id}
                      className={`${styles.libraryItem} ${isActive ? styles.active : ""}`}
                    >
                      <span
                        className={styles.colorDot}
                        style={{ background: color }}
                        aria-hidden
                      />
                      <button
                        className={styles.libraryItemBody}
                        onClick={() => setActiveSource(s.id)}
                        title={
                          isActive
                            ? "Active in preview"
                            : "Click to make this the active source"
                        }
                      >
                        <span className={styles.libraryItemName}>
                          {s.meta.name}
                        </span>
                        <span className={styles.libraryItemMeta}>
                          <span className="mono">
                            {formatTime(s.meta.duration)}
                          </span>
                          <span>
                            {`${s.meta.width}×${s.meta.height}`}
                          </span>
                          {s.meta.aspect && (
                            <span className="badge">{s.meta.aspect}</span>
                          )}
                          <span>
                            {(s.meta.size / 1024 / 1024).toFixed(1)} MB
                          </span>
                        </span>
                      </button>
                      <div className={styles.libraryItemActions}>
                        <input
                          type="checkbox"
                          className={styles.libraryCheckbox}
                          checked={isSelected}
                          onChange={() => toggleSourceSelection(s.id)}
                          title={
                            isSelected
                              ? "Eligible for AI — click to exclude"
                              : "Excluded from AI — click to include"
                          }
                          aria-label={`Include ${s.meta.name} in AI runs`}
                        />
                        <button
                          className={styles.removeIconBtn}
                          onClick={() => handleRemoveSource(s.id, s.meta.name)}
                          aria-label={`Remove ${s.meta.name}`}
                          title="Remove from library"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>

              <div className={styles.libraryControls}>
                <button
                  className={styles.libraryAddBtn}
                  onClick={() => fileRef.current?.click()}
                  disabled={atCountCap || atByteCap}
                  title={
                    atCountCap
                      ? `Library cap is ${LIBRARY_LIMITS.maxCount} videos`
                      : atByteCap
                        ? "Library size cap reached — remove one to add more"
                        : "Upload more videos"
                  }
                >
                  <Plus size={13} />
                  {atCountCap || atByteCap
                    ? "Library full"
                    : "Add another video"}
                </button>

                <div className={styles.libraryFooter}>
                  <span>
                    {selectedSourceIds.length} of {sources.length} selected for AI
                  </span>
                  <span className="mono">
                    {(totalBytes / 1024 / 1024).toFixed(0)} MB
                  </span>
                </div>
              </div>
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="video/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void handleFiles(e.target.files);
              e.currentTarget.value = "";
            }}
          />
        </div>
      </div>

      {/* ─── Progress ──────────────────────────────────────────────── */}
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

      {/* ─── Memory ────────────────────────────────────────────────── */}
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

      {/* ─── History ───────────────────────────────────────────────── */}
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
                    <span className="faint">
                      {new Date(h.updatedAt).toLocaleString()}
                      {h.sources && h.sources.length > 1
                        ? ` · ${h.sources.length} videos`
                        : ""}
                    </span>
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

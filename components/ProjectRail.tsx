"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Upload,
  Plus,
  Trash2,
  History as HistoryIcon,
  Film,
  AlertTriangle
} from "lucide-react";
import { useEditorStore } from "@/hooks/useEditorStore";
import { safeVideoFingerprint } from "@/lib/util/hash";
import { probeVideo } from "@/lib/pipeline/sample";
import { materializeStableBlob } from "@/lib/util/stableBlob";
import { formatTime } from "@/lib/util/time";
import { logUser } from "@/lib/log/recorders";
import { LIBRARY_LIMITS, SOURCE_COLORS } from "@/lib/config";
import { summarizeSession } from "@/lib/store/projectRestore";
import styles from "./ProjectRail.module.css";

export function ProjectRail() {
  const fileRef = useRef<HTMLInputElement>(null);
  const sources = useEditorStore((s) => s.sources);
  const missingSources = useEditorStore((s) => s.missingSources);
  const activeSourceId = useEditorStore((s) => s.activeSourceId);
  const selectedSourceIds = useEditorStore((s) => s.selectedSourceIds);
  const hydrateRestoredSource = useEditorStore((s) => s.hydrateRestoredSource);
  const removeSource = useEditorStore((s) => s.removeSource);
  const setActiveSource = useEditorStore((s) => s.setActiveSource);
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

  // Transient "Restored previous video: …" confirmation after a hash match.
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  const totalBytes = useMemo(
    () => sources.reduce((acc, s) => acc + s.meta.size, 0),
    [sources]
  );
  const atCountCap = sources.length >= LIBRARY_LIMITS.maxCount;
  const hasLibrary = sources.length > 0 || missingSources.length > 0;
  // Only count selections that point at videos actually loaded in the
  // library — a stale id from a missing/restored source would otherwise
  // render a nonsensical "1 of 0 selected for AI".
  const selectedLoadedCount = useMemo(
    () => selectedSourceIds.filter((id) => sources.some((s) => s.id === id)).length,
    [selectedSourceIds, sources]
  );

  async function handleFiles(fileList: FileList) {
    const files = Array.from(fileList);
    for (const file of files) {
      try {
        const probe = await probeVideo(file);
        const hash = await safeVideoFingerprint(file);
        // Was this file one of the project's missing sources? Decide by
        // HASH only (filenames are weak), BEFORE hydration mutates state.
        const matched = useEditorStore
          .getState()
          .missingSources.find((p) => p.hash === hash);

        const added = hydrateRestoredSource(
          await materializeStableBlob(file),
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
        if (matched) {
          setRestoreNotice(`Restored previous video: ${matched.meta.name}`);
          logUser({
            sessionId,
            kind: "video.uploaded",
            payload: {
              sourceId: added.id,
              name: file.name,
              restored: true,
              matchedSourceId: matched.id
            },
            summary: `Reconnected "${file.name}" to the restored project (hash match)`
          });
        } else {
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
        }
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
          {/* Missing-source banner — honest, hash-based restore prompt. */}
          {missingSources.length > 0 && (
            <div className={styles.missingBanner}>
              <strong>
                This project needs {missingSources.length} missing{" "}
                {missingSources.length === 1 ? "video" : "videos"}.
              </strong>
              <span className={styles.missingBannerFiles}>
                Re-upload:{" "}
                {missingSources.map((p) => p.meta.name).join(", ")}
              </span>
            </div>
          )}

          {restoreNotice && (
            <div className={styles.restoreNotice}>{restoreNotice}</div>
          )}

          {!hasLibrary ? (
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
                        <span className={styles.libraryItemName}>{s.meta.name}</span>
                        <span className={styles.libraryItemMeta}>
                          <span className="mono">
                            {formatTime(s.meta.duration)}
                          </span>
                          <span>{`${s.meta.width}×${s.meta.height}`}</span>
                          {s.meta.aspect && <span className="badge">{s.meta.aspect}</span>}
                          <span>{(s.meta.size / 1024 / 1024).toFixed(1)} MB</span>
                        </span>
                      </button>
                      <div className={styles.libraryItemActions}>
                        <span
                          className={`${styles.sourceState} ${
                            isSelected ? styles.sourceStateOn : styles.sourceStateOff
                          }`}
                          title={
                            isSelected
                              ? "This video is eligible for AI picks"
                              : "This video is excluded from AI picks"
                          }
                        >
                          {isSelected ? "AI" : "Skip"}
                        </span>
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

                {/* Missing placeholders — keep the original id; show a
                    re-upload affordance. No object URL is ever created. */}
                {missingSources.map((p) => (
                  <li
                    key={p.id}
                    className={`${styles.libraryItem} ${styles.missing}`}
                  >
                    <span
                      className={styles.colorDot}
                      style={{ background: "var(--warn)" }}
                      aria-hidden
                    />
                    <div className={styles.libraryItemBody}>
                      <span className={styles.libraryItemName}>{p.meta.name}</span>
                      <span className={styles.libraryItemMeta}>
                        <span className="mono">{formatTime(p.meta.duration)}</span>
                        {p.meta.aspect && <span className="badge">{p.meta.aspect}</span>}
                      </span>
                    </div>
                    <div className={styles.missingFooter}>
                      <span className={styles.missingTag}>
                        <AlertTriangle size={9} /> Missing
                      </span>
                      <button
                        className={styles.reuploadBtn}
                        onClick={() => fileRef.current?.click()}
                        title={`Re-upload "${p.meta.name}" to reconnect this project`}
                      >
                        <Upload size={11} /> Re-upload
                      </button>
                    </div>
                  </li>
                ))}
              </ul>

              <div className={styles.libraryControls}>
                <button
                  className={styles.libraryAddBtn}
                  onClick={() => fileRef.current?.click()}
                  disabled={atCountCap}
                  title={
                    atCountCap
                      ? `Library cap is ${LIBRARY_LIMITS.maxCount} videos`
                      : "Upload more videos"
                  }
                >
                  <Plus size={13} />
                  {atCountCap ? "Library full" : "Add another video"}
                </button>

                <div className={styles.libraryFooter}>
                  <span>
                    {selectedLoadedCount} of {sources.length} selected for AI
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
              {history.slice(0, 8).map((h) => {
                const sum = summarizeSession(h);
                return (
                  <li key={h.id} className={styles.historyItem}>
                    <button
                      className={styles.historyButton}
                      onClick={() => void restoreSession(h.id)}
                      title={sum.lastAction ?? h.title}
                    >
                      <span className={styles.historyTitle}>{h.title}</span>
                      <span className="faint">
                        {new Date(h.updatedAt).toLocaleString()}
                      </span>
                      <span className={styles.historyMeta}>
                        {sum.sourceCount > 0 && (
                          <span className={styles.historyChip}>
                            {sum.sourceCount}{" "}
                            {sum.sourceCount === 1 ? "video" : "videos"}
                          </span>
                        )}
                        {sum.clipCount > 0 && (
                          <span className={styles.historyChip}>
                            {sum.clipCount} clip{sum.clipCount === 1 ? "" : "s"}
                          </span>
                        )}
                        {sum.totalDurationSeconds > 0 && (
                          <span className={styles.historyChip}>
                            {formatTime(sum.totalDurationSeconds)}
                          </span>
                        )}
                        {sum.format && (
                          <span className={styles.historyChip}>{sum.format}</span>
                        )}
                        {sum.status !== "idle" && (
                          <span className={styles.historyChip}>
                            {labelStatus(sum.status)}
                          </span>
                        )}
                        {sum.restoreNeededCount > 0 && (
                          <span
                            className={`${styles.historyChip} ${styles.historyChipWarn}`}
                            title="Videos aren't stored in the browser — re-upload them to restore this project"
                          >
                            {sum.restoreNeededCount === sum.sourceCount
                              ? "needs re-upload"
                              : `${sum.restoreNeededCount} need re-upload`}
                          </span>
                        )}
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
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </aside>
  );
}

function labelStatus(s: string): string {
  if (s === "idle") return "Idle";
  if (s === "needs_review") return "Needs review";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

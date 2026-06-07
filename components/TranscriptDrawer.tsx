"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  FileText,
  Loader2,
  RefreshCw,
  Search,
  X
} from "lucide-react";
import { useEditorStore } from "@/hooks/useEditorStore";
import { useTranscription } from "@/hooks/useTranscription";
import type { TranscriptSegment } from "@/lib/audio/types";
import styles from "./TranscriptDrawer.module.css";

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * v1.7.3 — TranscriptDrawer.
 *
 * Right-side drawer that mirrors the existing ClipsDrawer/ActivityDrawer
 * pattern (uses the global .drawer-scrim + .drawer-panel utility
 * classes from app/globals.css). Scope is intentionally tight for
 * Phase 1:
 *
 *   - Render the active source's transcript segments with timestamps.
 *   - Tapping a segment scrubs the preview to that timestamp (same
 *     pattern as BriefingCard's scrub-to handler).
 *   - Search box highlights matching text in-place.
 *   - "Re-transcribe" triggers a forced run via useTranscription.
 *   - "Download .srt" emits a SubRip file for any consumer (YouTube,
 *     editing apps).
 *
 * No API call here. Everything is local — same privacy story as the
 * rest of the app. The drawer only renders the in-memory transcripts
 * dictionary; useTranscription owns the lifecycle.
 */
export function TranscriptDrawer({ open, onClose }: Props) {
  const { transcript, progress, isRunning, start, enabled } = useTranscription();
  const activeSourceId = useEditorStore((s) => s.activeSourceId);
  const sources = useEditorStore((s) => s.sources);
  const [search, setSearch] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  const [activeSegId, setActiveSegId] = useState<string | null>(null);

  const activeSource = sources.find((s) => s.id === activeSourceId) ?? null;

  // Filter segments by search text. Case-insensitive substring; we do
  // it on every keystroke because transcripts are O(hundreds) and
  // filtering is instant.
  const filtered = useMemo(() => {
    if (!transcript) return [] as TranscriptSegment[];
    if (!search.trim()) return transcript.segments;
    const q = search.trim().toLowerCase();
    return transcript.segments.filter((s) => s.text.toLowerCase().includes(q));
  }, [transcript, search]);

  // Reset search when the active source changes so old hits don't
  // bleed across sources.
  useEffect(() => {
    setSearch("");
    setActiveSegId(null);
  }, [activeSourceId]);

  // ESC closes; standard expectation in modal/drawer UI.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function handleScrubTo(seg: TranscriptSegment) {
    setActiveSegId(seg.id);
    const v = document.querySelector("video.preview") as HTMLVideoElement | null;
    if (!v) return;
    const apply = () => {
      try {
        v.currentTime = Math.max(0, seg.start);
        v.play().catch(() => {});
      } catch {
        // pre-metadata seek; the listener below catches it
      }
    };
    if (v.readyState >= 1) apply();
    else v.addEventListener("loadedmetadata", apply, { once: true });
  }

  function handleRetranscribe() {
    if (!activeSourceId) return;
    void start({ sourceId: activeSourceId, force: true });
  }

  function handleDownloadSrt() {
    if (!transcript || transcript.segments.length === 0) return;
    const srt = toSrt(transcript.segments);
    const blob = new Blob([srt], { type: "application/x-subrip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download =
      (transcript.sourceId
        ? sources.find((s) => s.id === transcript.sourceId)?.meta.name ??
          "transcript"
        : "transcript") + ".srt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  if (!open) return null;

  return (
    <>
      <div
        className="drawer-scrim"
        role="presentation"
        onClick={onClose}
      />
      <div
        className={`drawer-panel ${styles.drawer}`}
        role="dialog"
        aria-label="Transcript"
      >
        <div className={`card ${styles.host}`}>
          <header className={styles.head}>
            <span className={styles.headIcon} aria-hidden>
              <FileText size={14} />
            </span>
            <span className={styles.headTitle}>Transcript</span>
            {transcript && (
              <span className={styles.headMeta}>
                {transcript.segments.length} seg \u2022{" "}
                {Math.round(transcript.durationSeconds)}s
              </span>
            )}
            <button
              className={styles.closeBtn}
              onClick={onClose}
              aria-label="Close transcript"
              title="Close"
            >
              <X size={14} />
            </button>
          </header>

          {!enabled ? (
            <div className={styles.empty}>
              Voice understanding is unavailable on this device.
              <br />
              <span className="faint">
                Whisper requires a modern browser with Web Audio API support.
              </span>
            </div>
          ) : !activeSource ? (
            <div className={styles.empty}>
              Upload a video first \u2014 transcripts attach to the active
              source.
            </div>
          ) : (
            <>
              <div className={styles.toolbar}>
                <div className={styles.searchWrap}>
                  <Search size={12} className={styles.searchIcon} aria-hidden />
                  <input
                    type="search"
                    className={styles.searchInput}
                    placeholder="Search transcript\u2026"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    aria-label="Search transcript"
                  />
                </div>
                <button
                  className={styles.toolBtn}
                  onClick={handleRetranscribe}
                  disabled={isRunning}
                  title="Re-run transcription from scratch"
                >
                  <RefreshCw size={11} />
                  {isRunning ? "Running" : "Re-run"}
                </button>
                <button
                  className={styles.toolBtn}
                  onClick={handleDownloadSrt}
                  disabled={!transcript || transcript.segments.length === 0}
                  title="Download as SubRip (.srt)"
                >
                  <Download size={11} />
                  .srt
                </button>
              </div>

              <div className={`${styles.body} scroll-y`}>
                {isRunning && progress && progress.phase !== "done" && (
                  <div className={styles.statusCard}>
                    <span className={styles.statusCardIcon}>
                      <Loader2 size={14} className="spin" style={{ animation: "spin 0.9s linear infinite" }} />
                    </span>
                    <span className={styles.statusCardLabel}>
                      <span className={styles.statusCardTitle}>
                        {labelForPhase(progress.phase)}
                      </span>
                      <span className={styles.statusCardSub}>
                        {progress.detail ?? `${Math.round(progress.progress * 100)}%`}
                      </span>
                    </span>
                    <span className={styles.statusBar} aria-hidden>
                      <span
                        className={styles.statusFill}
                        style={{
                          width: `${Math.round(progress.progress * 100)}%`
                        }}
                      />
                    </span>
                  </div>
                )}

                {!isRunning && (!transcript || transcript.segments.length === 0) && (
                  <div className={styles.empty}>
                    {transcript && transcript.segments.length === 0
                      ? "No speech detected in this source."
                      : "No transcript yet for this source."}
                    {!isRunning && (
                      <div>
                        <button
                          className={styles.emptyAction}
                          onClick={handleRetranscribe}
                        >
                          <RefreshCw size={12} />
                          Transcribe now
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {transcript && transcript.segments.length > 0 && (
                  <ul ref={listRef} className={styles.list}>
                    {filtered.map((seg) => (
                      <li key={seg.id}>
                        <button
                          type="button"
                          className={`${styles.row} ${activeSegId === seg.id ? styles.active : ""}`}
                          onClick={() => handleScrubTo(seg)}
                          title={`Jump to ${formatTime(seg.start)}`}
                        >
                          <span className={styles.rowTime}>
                            {formatTime(seg.start)}
                          </span>
                          <span
                            className={styles.rowText}
                            dangerouslySetInnerHTML={{
                              __html: highlightMatches(seg.text, search)
                            }}
                          />
                        </button>
                      </li>
                    ))}
                    {filtered.length === 0 && (
                      <li className={styles.empty}>No matches.</li>
                    )}
                  </ul>
                )}
              </div>

              {transcript && (
                <footer className={styles.foot}>
                  <span className={styles.modelTag}>
                    {transcript.model.replace("Xenova/", "")}
                  </span>
                  <span>
                    Transcribed in {(transcript.transcribeMs / 1000).toFixed(1)}s
                  </span>
                </footer>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function labelForPhase(phase: string): string {
  switch (phase) {
    case "queued":
      return "Queued\u2026";
    case "decoding":
      return "Decoding audio";
    case "loading-model":
      return "Loading Whisper model";
    case "transcribing":
      return "Transcribing";
    case "done":
      return "Done";
    case "error":
      return "Error";
    default:
      return "Working\u2026";
  }
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds - Math.floor(seconds)) * 10);
  return `${m}:${String(s).padStart(2, "0")}.${ms}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function highlightMatches(text: string, query: string): string {
  const safe = escapeHtml(text);
  const q = query.trim();
  if (!q) return safe;
  // Build a case-insensitive match without exposing the raw query to
  // the regex engine — escape meta chars first.
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(${escaped})`, "ig");
  return safe.replace(re, "<mark>$1</mark>");
}

/** v1.7.3 — Convert transcript segments to SubRip (.srt) format.
 *  Standard format consumed by every video editor on the planet. */
function toSrt(segments: TranscriptSegment[]): string {
  const lines: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    lines.push(String(i + 1));
    lines.push(`${srtTime(s.start)} --> ${srtTime(s.end)}`);
    lines.push(s.text);
    lines.push("");
  }
  return lines.join("\n");
}

function srtTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(ms)}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

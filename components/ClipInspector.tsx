"use client";

import { useMemo } from "react";
import { ChevronLeft, ChevronRight, Trash2, ChevronsLeft, ChevronsRight, Quote } from "lucide-react";
import { useEditorStore } from "@/hooks/useEditorStore";
import { formatSeconds } from "@/lib/util/time";
import { logUser } from "@/lib/log/recorders";
import styles from "./ClipInspector.module.css";

export function ClipInspector() {
  const highlights = useEditorStore((s) => s.highlights);
  const selectedId = useEditorStore((s) => s.selectedClipId);
  const updateHighlight = useEditorStore((s) => s.updateHighlight);
  const removeHighlight = useEditorStore((s) => s.removeHighlight);
  const sessionId = useEditorStore((s) => s.sessionId);
  // v1.7.3 — Pull the transcript dictionary + sources to render the
  // in-clip speech snippet. We resolve via the clip's sourceId (or the
  // active source when a clip pre-dates the multi-source store).
  const transcripts = useEditorStore((s) => s.transcripts);
  const sources = useEditorStore((s) => s.sources);
  const activeSourceId = useEditorStore((s) => s.activeSourceId);

  const clip = highlights.find((h) => h.id === selectedId);

  // v1.7.3 — Compute the in-clip transcript snippet outside the early
  // return so the hook order stays stable across renders. Returns
  // null when there's no clip selected, no transcript for the clip's
  // source, or no segments overlap the clip's time range.
  const snippet = useMemo(() => {
    if (!clip) return null;
    const sid = clip.sourceId ?? activeSourceId ?? null;
    if (!sid) return null;
    const src = sources.find((s) => s.id === sid);
    if (!src) return null;
    const t = transcripts[src.hash];
    if (!t || t.segments.length === 0) return null;
    // Keep any segment that overlaps the clip's [start, end] range
    // (start before clip.end AND end after clip.start). Concatenate
    // their text — Whisper segments are short enough that even a 30s
    // clip rarely exceeds 5 segments. Cap at ~600 chars for the UI.
    const overlapping = t.segments.filter(
      (seg) => seg.start < clip.end && seg.end > clip.start
    );
    if (overlapping.length === 0) return null;
    const text = overlapping.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
    return text.slice(0, 600);
  }, [clip, sources, activeSourceId, transcripts]);

  if (!clip) {
    return (
      <div className={styles.inspector}>
        <p className="faint">Select a clip on the timeline to inspect it.</p>
      </div>
    );
  }

  const length = clip.end - clip.start;

  function nudge(field: "start" | "end", delta: number) {
    if (!clip) return;
    const next = { ...clip, [field]: Math.max(0, clip[field] + delta) };
    if (next.end - next.start < 0.5) return;
    updateHighlight(clip.id, next);
    logUser({
      sessionId,
      kind: "clip.nudged",
      payload: {
        clipId: clip.id,
        field,
        delta: Math.round(delta * 100) / 100,
        from: Math.round(clip[field] * 100) / 100,
        to: Math.round(next[field] * 100) / 100
      },
      summary: `Nudged clip ${shortId(clip.id)} ${field} by ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}s`
    });
  }

  function handleRemove() {
    if (!clip) return;
    logUser({
      sessionId,
      kind: "clip.removed",
      payload: {
        clipId: clip.id,
        start: Math.round(clip.start * 100) / 100,
        end: Math.round(clip.end * 100) / 100,
        reason: clip.reason
      },
      summary: `Removed clip ${shortId(clip.id)} (${(clip.end - clip.start).toFixed(1)}s)`
    });
    removeHighlight(clip.id);
  }

  return (
    <div className={styles.inspector}>
      <div className={styles.row}>
        <label className={styles.field}>
          <span className="faint">Start</span>
          <input
            type="number"
            step="0.1"
            min="0"
            className="input mono"
            value={clip.start.toFixed(2)}
            onChange={(e) =>
              updateHighlight(clip.id, {
                start: Math.min(clip.end - 0.2, Math.max(0, parseFloat(e.target.value) || 0))
              })
            }
          />
        </label>

        <label className={styles.field}>
          <span className="faint">End</span>
          <input
            type="number"
            step="0.1"
            min="0"
            className="input mono"
            value={clip.end.toFixed(2)}
            onChange={(e) =>
              updateHighlight(clip.id, {
                end: Math.max(clip.start + 0.2, parseFloat(e.target.value) || 0)
              })
            }
          />
        </label>

        <label className={styles.field}>
          <span className="faint">Length</span>
          <span className={`${styles.lengthValue} mono`}>{formatSeconds(length)}</span>
        </label>

        <div className={styles.spacer} />

        <div className={styles.nudgeGroup}>
          <button className="btn icon" aria-label="Move start back" onClick={() => nudge("start", -0.5)}>
            <ChevronsLeft size={14} />
          </button>
          <button className="btn icon" aria-label="Nudge start back" onClick={() => nudge("start", -0.1)}>
            <ChevronLeft size={14} />
          </button>
          <button className="btn icon" aria-label="Nudge end forward" onClick={() => nudge("end", 0.1)}>
            <ChevronRight size={14} />
          </button>
          <button className="btn icon" aria-label="Move end forward" onClick={() => nudge("end", 0.5)}>
            <ChevronsRight size={14} />
          </button>
        </div>

        <button
          className="btn danger"
          onClick={handleRemove}
        >
          <Trash2 size={14} /> Remove
        </button>
      </div>

      {clip.reason && (
        <p className={`muted ${styles.reason}`}>
          <span className="faint">Why:</span> {clip.reason}
        </p>
      )}

      {snippet && (
        <p className={`muted ${styles.reason}`}>
          <span className="faint">
            <Quote size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
            Said:
          </span>{" "}
          <span className={styles.transcriptSnippet}>{snippet}</span>
        </p>
      )}
    </div>
  );
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(-6) : id;
}

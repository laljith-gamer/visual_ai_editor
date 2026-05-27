"use client";

import { ChevronLeft, ChevronRight, Trash2, ChevronsLeft, ChevronsRight } from "lucide-react";
import { useEditorStore } from "@/hooks/useEditorStore";
import { formatSeconds } from "@/lib/util/time";
import styles from "./ClipInspector.module.css";

export function ClipInspector() {
  const highlights = useEditorStore((s) => s.highlights);
  const selectedId = useEditorStore((s) => s.selectedClipId);
  const updateHighlight = useEditorStore((s) => s.updateHighlight);
  const removeHighlight = useEditorStore((s) => s.removeHighlight);

  const clip = highlights.find((h) => h.id === selectedId);

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
          onClick={() => removeHighlight(clip.id)}
        >
          <Trash2 size={14} /> Remove
        </button>
      </div>

      {clip.reason && (
        <p className={`muted ${styles.reason}`}>
          <span className="faint">Why:</span> {clip.reason}
        </p>
      )}
    </div>
  );
}

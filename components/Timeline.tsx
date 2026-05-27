"use client";

import { useMemo, useRef, useState } from "react";
import { useEditorStore } from "@/hooks/useEditorStore";
import { formatTime } from "@/lib/util/time";
import styles from "./Timeline.module.css";

type DragMode = "move" | "resize-l" | "resize-r" | null;

interface DragState {
  id: string;
  mode: DragMode;
  startX: number;
  origStart: number;
  origEnd: number;
}

export function Timeline() {
  const highlights = useEditorStore((s) => s.highlights);
  const videoMeta = useEditorStore((s) => s.videoMeta);
  const updateHighlight = useEditorStore((s) => s.updateHighlight);
  const selectClip = useEditorStore((s) => s.selectClip);
  const selectedId = useEditorStore((s) => s.selectedClipId);

  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const duration = videoMeta?.duration ?? Math.max(...highlights.map((h) => h.end), 60);

  const totalSelected = useMemo(
    () => highlights.reduce((acc, h) => acc + (h.end - h.start), 0),
    [highlights]
  );

  function pxToSec(deltaPx: number): number {
    const w = trackRef.current?.clientWidth ?? 1;
    return (deltaPx / w) * duration;
  }

  function onMouseDown(
    e: React.PointerEvent<HTMLDivElement>,
    h: { id: string; start: number; end: number },
    mode: NonNullable<DragMode>
  ) {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({
      id: h.id,
      mode,
      startX: e.clientX,
      origStart: h.start,
      origEnd: h.end
    });
    selectClip(h.id);
  }

  function onMouseMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag) return;
    const deltaSec = pxToSec(e.clientX - drag.startX);
    if (drag.mode === "move") {
      const len = drag.origEnd - drag.origStart;
      let start = Math.max(0, Math.min(duration - len, drag.origStart + deltaSec));
      updateHighlight(drag.id, { start, end: start + len });
    } else if (drag.mode === "resize-l") {
      const start = Math.max(0, Math.min(drag.origEnd - 0.5, drag.origStart + deltaSec));
      updateHighlight(drag.id, { start });
    } else if (drag.mode === "resize-r") {
      const end = Math.max(drag.origStart + 0.5, Math.min(duration, drag.origEnd + deltaSec));
      updateHighlight(drag.id, { end });
    }
  }

  function onMouseUp(e: React.PointerEvent<HTMLDivElement>) {
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    setDrag(null);
  }

  return (
    <div className={styles.timeline}>
      <div className={styles.header}>
        <span className="muted">
          {highlights.length} clip{highlights.length === 1 ? "" : "s"}
        </span>
        <span className="muted">·</span>
        <span className="muted">{formatTime(totalSelected)} selected</span>
        <div className="spacer" />
        <span className="faint">Source: {formatTime(duration)}</span>
      </div>

      <div
        ref={trackRef}
        className={styles.track}
        onPointerMove={onMouseMove}
        onPointerUp={onMouseUp}
        onPointerCancel={onMouseUp}
      >
        {highlights.length === 0 && (
          <p className={`faint ${styles.empty}`}>
            No clips yet. Send the assistant a request to plan a short.
          </p>
        )}

        {highlights.map((h) => {
          const left = (h.start / duration) * 100;
          const width = ((h.end - h.start) / duration) * 100;
          const selected = selectedId === h.id;
          return (
            <div
              key={h.id}
              className={`${styles.clip} ${selected ? styles.selected : ""}`}
              style={{ left: `${left}%`, width: `${width}%` }}
              onPointerDown={(e) => onMouseDown(e, h, "move")}
              onClick={() => selectClip(h.id)}
              role="button"
              tabIndex={0}
            >
              <div
                className={`${styles.handle} ${styles.left}`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onMouseDown(e, h, "resize-l");
                }}
              />
              <div className={styles.clipBody}>
                <span className={styles.clipName}>
                  {h.label ?? "clip"}
                </span>
                <span className={`mono ${styles.clipDuration}`}>
                  {(h.end - h.start).toFixed(1)}s
                </span>
              </div>
              <div
                className={`${styles.handle} ${styles.right}`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onMouseDown(e, h, "resize-r");
                }}
              />
            </div>
          );
        })}

        <div className={styles.tickRow}>
          {ticks(duration).map((t) => (
            <span
              key={t}
              className={styles.tick}
              style={{ left: `${(t / duration) * 100}%` }}
            >
              <em>{formatTime(t)}</em>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function ticks(duration: number): number[] {
  const target = 8;
  const step = niceStep(duration / target);
  const out: number[] = [];
  for (let t = 0; t <= duration + 0.001; t += step) out.push(Math.round(t));
  return out;
}

function niceStep(raw: number): number {
  const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  for (const c of candidates) if (c >= raw) return c;
  return 600;
}

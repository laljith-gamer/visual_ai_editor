"use client";

import { X, Trash2 } from "lucide-react";
import { useEditorStore } from "@/hooks/useEditorStore";
import { formatSeconds, formatTime } from "@/lib/util/time";
import styles from "./ClipsDrawer.module.css";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ClipsDrawer({ open, onClose }: Props) {
  const highlights = useEditorStore((s) => s.highlights);
  const selectClip = useEditorStore((s) => s.selectClip);
  const removeHighlight = useEditorStore((s) => s.removeHighlight);

  if (!open) return null;
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} aria-hidden />
      <aside className={`drawer-panel card ${styles.drawer}`}>
        <div className="card-header row gap">
          <span>Clips</span>
          <span className="pill">{highlights.length}</span>
          <div className="spacer" />
          <button className="btn icon" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className={`scroll-y ${styles.list}`}>
          {highlights.length === 0 && (
            <p className="faint" style={{ padding: 16 }}>
              No clips yet.
            </p>
          )}
          {highlights.map((h, i) => (
            <article
              key={h.id}
              className={styles.item}
              onClick={() => {
                selectClip(h.id);
                onClose();
              }}
            >
              <div className={styles.itemHead}>
                <span className={styles.itemIndex}>#{i + 1}</span>
                <span className="mono">{formatTime(h.start)} → {formatTime(h.end)}</span>
                <span className="spacer" />
                <span className="pill accent mono">{formatSeconds(h.end - h.start)}</span>
              </div>
              {h.reason && <p className={`muted ${styles.itemReason}`}>{h.reason}</p>}
              <div className={styles.itemFooter}>
                {h.label && <span className="pill">{h.label}</span>}
                {h.transition && h.transition !== "none" && (
                  <span className="pill info">{h.transition}</span>
                )}
                <span className="pill warn mono">{(h.score * 100).toFixed(0)}</span>
                <span className="spacer" />
                <button
                  className="btn icon danger"
                  aria-label="Remove clip"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeHighlight(h.id);
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </article>
          ))}
        </div>
      </aside>
    </>
  );
}

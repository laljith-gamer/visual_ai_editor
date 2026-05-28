"use client";

import { useEffect, useState } from "react";
import { Film } from "lucide-react";
import styles from "./FrameStrip.module.css";

interface Props {
  /** Total slot count — pre-rendered as skeleton cells. */
  slots: number;
  /** Object URLs for the thumbnails extracted so far. */
  frames: string[];
}

/**
 * Horizontal strip of slots that fill in as real video frames are
 * extracted by the launch page's pipeline. Each new frame fades + zooms
 * in on top of its skeleton cell. Once all slots fill, a soft "scan"
 * highlight sweeps across left-to-right to signal "all done".
 *
 * We keep slot count and frame URLs separate (instead of just
 * rendering frames.length cells) so the user sees the *intent* of the
 * strip from the very first paint — eight empty skeletons set
 * expectations for "real frames are about to land here".
 */
export function FrameStrip({ slots, frames }: Props) {
  const cells: Array<string | null> = new Array(slots)
    .fill(null)
    .map((_, i) => frames[i] ?? null);
  const allFilled = frames.length >= slots;

  // Once filled, fire a one-shot sweep highlight by toggling a class
  // for 700ms. We use state so we can later support replays if the
  // strip is re-mounted with the same data.
  const [sweep, setSweep] = useState(false);
  useEffect(() => {
    if (allFilled) {
      setSweep(true);
      const t = setTimeout(() => setSweep(false), 700);
      return () => clearTimeout(t);
    }
  }, [allFilled]);

  return (
    <div className={styles.wrap} role="img" aria-label="Frame preview">
      <div className={styles.head}>
        <span className={styles.headIcon}>
          <Film size={12} />
        </span>
        <span className={styles.headLabel}>FRAMES</span>
        <span className={styles.headCount}>
          {frames.length}/{slots}
        </span>
      </div>
      <div className={`${styles.strip} ${sweep ? styles.sweep : ""}`}>
        {cells.map((url, i) => (
          <div
            key={i}
            className={`${styles.cell} ${url ? styles.filled : ""}`}
            style={{ animationDelay: `${i * 0.04}s` }}
          >
            {url ? (
              <img
                className={styles.frameImg}
                src={url}
                alt=""
                aria-hidden
              />
            ) : (
              <span className={styles.shimmer} aria-hidden />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

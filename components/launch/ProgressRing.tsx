"use client";

import styles from "./ProgressRing.module.css";

interface Props {
  /** 0..1 */
  value: number;
  /** Center caption — short word like "Reading" or a stage label. */
  label?: string;
  /** Sub-caption — the file name or a stage detail. */
  detail?: string;
  /** When true, render a brighter rim and stop the rotating shimmer. */
  done?: boolean;
}

const SIZE = 220;
const STROKE = 6;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Big circular progress indicator. Two concentric rings: a faint track
 * and an animated foreground that fills clockwise. The percentage in
 * the centre counts up smoothly because the parent passes a smoothed
 * value (via requestAnimationFrame easing) — the SVG itself just
 * renders whatever it gets.
 */
export function ProgressRing({ value, label, detail, done }: Props) {
  const v = Math.max(0, Math.min(1, value));
  const dash = CIRCUMFERENCE * (1 - v);

  return (
    <div className={`${styles.wrap} ${done ? styles.done : ""}`}>
      {/* Animated halo behind the ring. Picks up the accent colour as
          progress increases (CSS custom property). */}
      <span
        className={styles.halo}
        aria-hidden
        style={{ "--p": v } as React.CSSProperties}
      />
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className={styles.svg}
        role="img"
        aria-label={`Progress ${Math.round(v * 100)}%`}
      >
        <defs>
          <linearGradient id="ring-grad" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="#63d895" />
            <stop offset="60%" stopColor="#75a7ff" />
            <stop offset="100%" stopColor="#a993ff" />
          </linearGradient>
        </defs>
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          stroke="rgba(255,255,255,0.06)"
          strokeWidth={STROKE}
          fill="none"
        />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          stroke="url(#ring-grad)"
          strokeWidth={STROKE}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={dash}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          className={styles.fill}
        />
      </svg>
      <div className={styles.center}>
        <div className={styles.percent}>
          <span className={styles.percentNum}>{Math.round(v * 100)}</span>
          <span className={styles.percentSign}>%</span>
        </div>
        {label && <div className={styles.label}>{label}</div>}
        {detail && (
          <div className={styles.detail} title={detail}>
            {detail}
          </div>
        )}
      </div>
    </div>
  );
}

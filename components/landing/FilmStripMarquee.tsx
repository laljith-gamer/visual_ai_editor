"use client";

import styles from "./FilmStripMarquee.module.css";

/**
 * Decorative below-the-fold-ish row of "film" cells that scrolls
 * horizontally on its own. Pure CSS animation, no JS, no images —
 * each cell is a CSS gradient that mimics a frame thumbnail. We
 * duplicate the cells once so the marquee can loop seamlessly using
 * `transform: translateX(-50%)`.
 *
 * Kept very intentionally subtle (low opacity, blurred edges) — its
 * job is to add motion in the periphery, not pull attention away
 * from the dropzone.
 */
const CELLS = [
  { from: "#1a3b2a", to: "#0e2018", hue: 0 },
  { from: "#2a3559", to: "#101725", hue: 1 },
  { from: "#3b2a59", to: "#180f25", hue: 2 },
  { from: "#1a3b3b", to: "#0e2020", hue: 0 },
  { from: "#594a2a", to: "#251c0f", hue: 1 },
  { from: "#3b1a2a", to: "#200e16", hue: 2 },
  { from: "#1a2b3b", to: "#0e1820", hue: 0 },
  { from: "#2a593b", to: "#0f2517", hue: 1 },
  { from: "#3b3b2a", to: "#202010", hue: 2 },
  { from: "#1a3b2e", to: "#0e2017", hue: 0 }
];

const DOUBLED = [...CELLS, ...CELLS];

export function FilmStripMarquee() {
  return (
    <div className={styles.wrap} aria-hidden>
      <div className={styles.track}>
        {DOUBLED.map((c, i) => (
          <div
            key={i}
            className={styles.cell}
            style={{
              background: `linear-gradient(135deg, ${c.from}, ${c.to})`,
              animationDelay: `${(i % CELLS.length) * 0.12}s`
            }}
          >
            <span className={styles.sprocketTop} />
            <span className={styles.sprocketBot} />
            <span className={styles.gloss} />
          </div>
        ))}
      </div>
    </div>
  );
}

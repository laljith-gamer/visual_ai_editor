"use client";

import Link from "next/link";
import { ArrowRight, Github } from "lucide-react";
import styles from "./LandingFooter.module.css";

/** Bottom-of-page footer. Doubles as a secondary CTA for users who
 *  scrolled past the hero without uploading. */
export function LandingFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className={styles.footer}>
      <div className={styles.cta}>
        <h3 className={styles.ctaTitle}>Ready when you are.</h3>
        <p className={styles.ctaBody}>
          Skip the upload and poke around the editor first — you can drop a
          file in there too.
        </p>
        <Link className={styles.ctaButton} href="/editor">
          Open editor <ArrowRight size={14} aria-hidden />
        </Link>
      </div>

      <div className={styles.bottom}>
        <span className={styles.brand}>Shorts Studio</span>
        <span className={styles.copy}>
          {year} - Browser-first video editing
        </span>
        <a
          className={styles.gh}
          href="https://github.com/laljith-gamer/visual_ai_editor"
          target="_blank"
          rel="noreferrer"
        >
          <Github size={14} aria-hidden />
          Source
        </a>
      </div>
    </footer>
  );
}

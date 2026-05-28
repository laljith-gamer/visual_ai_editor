"use client";

import Link from "next/link";
import { ArrowUpRight, Sparkles } from "lucide-react";
import styles from "./LandingTopbar.module.css";

/** Minimal top bar for the landing page. Mirrors the dimensions of
 *  the editor Topbar so the transition to /editor doesn't visually
 *  jump. Right side has a single low-emphasis "Open editor" link for
 *  returning users who don't want to re-upload. */
export function LandingTopbar() {
  return (
    <header className={styles.bar}>
      <div className={styles.brand}>
        <span className={styles.logoMark} aria-hidden>
          <Sparkles size={14} />
        </span>
        <span className={styles.brandName}>Shorts Studio</span>
        <span className={styles.brandTag}>v1.7</span>
      </div>
      <nav className={styles.nav}>
        <a className={styles.navLink} href="#how-it-works">
          How it works
        </a>
        <Link className={styles.openEditor} href="/editor">
          Open editor
          <ArrowUpRight size={14} />
        </Link>
      </nav>
    </header>
  );
}

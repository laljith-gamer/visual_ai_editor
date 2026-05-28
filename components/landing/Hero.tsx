"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Cpu, ShieldCheck, Zap } from "lucide-react";
import { UploadDropzone } from "./UploadDropzone";
import { FilmStripMarquee } from "./FilmStripMarquee";
import { useEditorStore } from "@/hooks/useEditorStore";
import styles from "./Hero.module.css";

/** Hero section. Two-column layout on desktop (copy + dropzone),
 *  stacked on mobile. Headline reveals one word at a time using a
 *  staggered CSS animation; the marquee underneath loops a row of
 *  film-strip mock thumbnails so the page feels alive even before
 *  the user does anything. */
export function Hero() {
  // Returning-user banner: if the in-memory store already has a
  // session with sources OR clips, we offer a one-click jump back
  // into the editor instead of forcing a re-upload.
  const sources = useEditorStore((s) => s.sources);
  const highlights = useEditorStore((s) => s.highlights);
  const sessionTitle = useEditorStore((s) => s.title);
  const hasSession = sources.length > 0 || highlights.length > 0;

  // Avoid a hydration flash where the banner renders on the server
  // (where the in-memory store is always empty) but then suddenly
  // appears on the client.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <section className={styles.hero}>
      <div className={styles.inner}>
        <div className={styles.copy}>
          <span className={styles.eyebrow}>
            <span className={styles.dot} aria-hidden />
            Browser-first  No upload leaves your device  Free
          </span>

          <h1 className={styles.headline}>
            {/* Each word is its own span so the stagger animation can
                animate them independently. The accent span gets a
                gradient and a slightly heavier weight. */}
            {"Turn long videos into shorts.".split(" ").map((w, i) => (
              <span
                key={`a-${i}`}
                className={styles.word}
                style={{ animationDelay: `${0.05 + i * 0.06}s` }}
              >
                {w}
              </span>
            ))}
            <br />
            <span className={`${styles.word} ${styles.accent}`} style={{ animationDelay: "0.45s" }}>
              Just
            </span>
            <span className={`${styles.word} ${styles.accent}`} style={{ animationDelay: "0.52s" }}>
              talk
            </span>
            <span className={`${styles.word} ${styles.accent}`} style={{ animationDelay: "0.59s" }}>
              to
            </span>
            <span className={`${styles.word} ${styles.accent}`} style={{ animationDelay: "0.66s" }}>
              it.
            </span>
          </h1>

          <p className={styles.sub}>
            Drop in raw footage. Tell the editor what kind of short you want,
            in plain language. It picks the moments, you tweak in the timeline,
            and renders right in your browser.
          </p>

          <ul className={styles.featureRow}>
            <li className={styles.feature}>
              <Zap size={14} aria-hidden /> Multi-signal scoring
            </li>
            <li className={styles.feature}>
              <Cpu size={14} aria-hidden /> WebGPU-accelerated
            </li>
            <li className={styles.feature}>
              <ShieldCheck size={14} aria-hidden /> Stays on device
            </li>
          </ul>

          {mounted && hasSession && (
            <Link className={styles.continueBanner} href="/editor">
              <span className={styles.continueLabel}>
                Pick up where you left off
                <span className={styles.continueTitle}>{sessionTitle}</span>
              </span>
              <ArrowRight size={16} />
            </Link>
          )}
        </div>

        <div className={styles.uploadCol}>
          <UploadDropzone />
        </div>
      </div>

      <FilmStripMarquee />
    </section>
  );
}

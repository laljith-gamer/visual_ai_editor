"use client";

import { MessageSquareText, UploadCloud, Wand2 } from "lucide-react";
import styles from "./HowItWorks.module.css";

interface Step {
  n: string;
  Icon: typeof UploadCloud;
  title: string;
  body: string;
  hue: "green" | "blue" | "violet";
}

const STEPS: Step[] = [
  {
    n: "01",
    Icon: UploadCloud,
    title: "Drop your footage",
    body:
      "Up to 8 videos in one session, 800 MB each. Everything stays in your browser. No accounts, no exports to a server.",
    hue: "green"
  },
  {
    n: "02",
    Icon: MessageSquareText,
    title: "Talk like a director",
    body:
      "“Find the funniest 30 seconds.” “Cut a vertical reel of the goal celebrations.” The planner translates that into structured edits.",
    hue: "blue"
  },
  {
    n: "03",
    Icon: Wand2,
    title: "Tweak and render",
    body:
      "Trim, split, swap clips on a multi-track timeline. Render to MP4 right in the tab — or jump back to the chat to refine.",
    hue: "violet"
  }
];

export function HowItWorks() {
  return (
    <section className={styles.section} id="how-it-works">
      <div className={styles.head}>
        <span className={styles.kicker}>How it works</span>
        <h2 className={styles.title}>Three steps. Zero learning curve.</h2>
        <p className={styles.lede}>
          The pipeline does the heavy lifting — frame sampling, multi-signal
          scoring, temporal verification — so you stay in the conversation.
        </p>
      </div>

      <ol className={styles.grid}>
        {STEPS.map((s, i) => (
          <li
            key={s.n}
            className={`${styles.card} ${styles[s.hue]}`}
            style={{ animationDelay: `${i * 0.1}s` }}
          >
            <span className={styles.num} aria-hidden>{s.n}</span>
            <span className={styles.icon} aria-hidden>
              <s.Icon size={22} />
            </span>
            <h3 className={styles.cardTitle}>{s.title}</h3>
            <p className={styles.cardBody}>{s.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

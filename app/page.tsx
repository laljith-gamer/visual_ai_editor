"use client";

import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { LandingTopbar } from "@/components/landing/LandingTopbar";
import styles from "./page.module.css";

/**
 * Home / landing page (v1.7.0). Replaces the previous editor-as-root
 * layout. The actual editor now lives at /editor; this page handles
 * the upload + first-impression animations and hands off to /launch
 * for the heavy probe+hash work.
 *
 * Sections (top → bottom):
 *   <Hero>           — animated mesh background, headline, dropzone.
 *   <HowItWorks>     — three-step explanation cards.
 *   <LandingFooter>  — minimal footer with skip-to-editor link.
 */
export default function HomePage() {
  return (
    <main className={styles.shell}>
      <LandingTopbar />
      <Hero />
      <HowItWorks />
      <LandingFooter />
    </main>
  );
}

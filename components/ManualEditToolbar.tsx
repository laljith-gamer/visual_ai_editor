"use client";

import { useState } from "react";
import {
  Scissors,
  TimerReset,
  Sparkles,
  Crop,
  SplitSquareHorizontal,
  Trash2
} from "lucide-react";
import { useEditorStore } from "@/hooks/useEditorStore";
import { logUser } from "@/lib/log/recorders";
import styles from "./ManualEditToolbar.module.css";

/**
 * Pure-client manual edit primitives. Zero LLM calls. v1.6.0.
 *
 *   ┌────────┬──────────────┬──────────────┬──────────────┬────────┐
 *   │ Trim │  Keep range │  Drop range │  Split    │  Reset  │
 *   │ first/last │  [a..b]   │  [a..b]     │  at clip   │         │
 *   └────────┴──────────────┴──────────────┴──────────────┴────────┘
 *
 * Each button operates on the ACTIVE source only. Other sources'
 * highlights are untouched. Each action also feeds into the activity
 * log so the planner sees what the user did and respects it on the
 * next AI turn (e.g., "user trimmed first 60s → they want it concise").
 *
 * The mm:ss inputs accept "1:30", "90", "1m30s" and degrade gracefully
 * on bad input. Parsing lives in `parseTimeInput` below.
 */
export function ManualEditToolbar() {
  const sessionId = useEditorStore((s) => s.sessionId);
  const activeSourceId = useEditorStore((s) => s.activeSourceId);
  const sources = useEditorStore((s) => s.sources);
  const highlights = useEditorStore((s) => s.highlights);
  const trimFirst = useEditorStore((s) => s.trimFirstSeconds);
  const trimLast = useEditorStore((s) => s.trimLastSeconds);
  const keepRange = useEditorStore((s) => s.keepRange);
  const dropRange = useEditorStore((s) => s.dropRange);
  const splitAt = useEditorStore((s) => s.splitAtTime);
  const resetActive = useEditorStore((s) => s.resetActiveSourceClips);
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const pushMessage = useEditorStore((s) => s.pushMessage);

  const activeSource = sources.find((s) => s.id === activeSourceId) ?? null;
  const activeName = activeSource?.meta.name ?? "active";
  const activeDuration = activeSource?.meta.duration ?? 0;
  const hasActive = !!activeSource;

  const [rangeStart, setRangeStart] = useState("0:00");
  const [rangeEnd, setRangeEnd] = useState("0:30");

  function announce(message: string) {
    pushMessage({ role: "assistant", content: message });
  }

  function logManual(
    kind: string,
    payload: Record<string, unknown>,
    summary: string
  ) {
    logUser({ sessionId, kind, payload, summary });
  }

  // ───── Trim first / last ──────────────────────────────────────────
  function doTrimFirst(seconds: number) {
    if (!hasActive) return;
    const r = trimFirst(seconds);
    logManual(
      "manual.trim_first",
      { sourceId: activeSourceId, seconds, changed: r.changed },
      `Trimmed first ${seconds}s on "${activeName}" (${r.changed} clip${r.changed === 1 ? "" : "s"} changed)`
    );
    if (r.changed === 0) {
      announce(
        `No clips fell inside the first ${formatSec(seconds)} of "${activeName}".`
      );
    } else {
      announce(
        `Trimmed the first ${formatSec(seconds)} \u2014 ${r.changed} clip${r.changed === 1 ? "" : "s"} adjusted.`
      );
    }
  }

  function doTrimLast(seconds: number) {
    if (!hasActive) return;
    const r = trimLast(seconds);
    logManual(
      "manual.trim_last",
      { sourceId: activeSourceId, seconds, changed: r.changed },
      `Trimmed last ${seconds}s on "${activeName}" (${r.changed} clip${r.changed === 1 ? "" : "s"} changed)`
    );
    if (r.changed === 0) {
      announce(
        `No clips fell inside the last ${formatSec(seconds)} of "${activeName}".`
      );
    } else {
      announce(
        `Trimmed the last ${formatSec(seconds)} \u2014 ${r.changed} clip${r.changed === 1 ? "" : "s"} adjusted.`
      );
    }
  }

  // ───── Keep / drop range ──────────────────────────────────────────
  function doKeepRange() {
    const a = parseTimeInput(rangeStart);
    const b = parseTimeInput(rangeEnd);
    if (a == null || b == null || b <= a) {
      announce(
        "Range looks off \u2014 use mm:ss like 0:30 to 1:45 with end after start."
      );
      return;
    }
    const r = keepRange(a, b);
    logManual(
      "manual.keep_range",
      { sourceId: activeSourceId, start: a, end: b, changed: r.changed },
      `Kept ${formatSec(a)}\u2013${formatSec(b)} on "${activeName}"`
    );
    announce(`Kept just ${formatSec(a)}\u2013${formatSec(b)} from "${activeName}".`);
  }

  function doDropRange() {
    const a = parseTimeInput(rangeStart);
    const b = parseTimeInput(rangeEnd);
    if (a == null || b == null || b <= a) {
      announce(
        "Range looks off \u2014 use mm:ss like 0:30 to 1:45 with end after start."
      );
      return;
    }
    const r = dropRange(a, b);
    logManual(
      "manual.drop_range",
      { sourceId: activeSourceId, start: a, end: b, changed: r.changed },
      `Dropped ${formatSec(a)}\u2013${formatSec(b)} on "${activeName}"`
    );
    announce(
      r.changed === 0
        ? `Nothing inside ${formatSec(a)}\u2013${formatSec(b)} to drop.`
        : `Dropped ${formatSec(a)}\u2013${formatSec(b)} \u2014 ${r.changed} clip${r.changed === 1 ? "" : "s"} affected.`
    );
  }

  // ───── Split at selected clip's start ────────────────────────────
  function doSplit() {
    const sel = highlights.find((h) => h.id === selectedClipId);
    if (!sel) {
      announce("Select a clip on the timeline first, then split it in two.");
      return;
    }
    // Split halfway through the selected clip — predictable and avoids
    // the user needing a separate "playhead" input. Power users with
    // exact timestamps can use Drop range to slice at any point.
    const mid = sel.start + (sel.end - sel.start) / 2;
    const r = splitAt(mid);
    logManual(
      "manual.split",
      { sourceId: activeSourceId, time: mid, changed: r.changed },
      `Split clip mid-point at ${formatSec(mid)} on "${activeName}"`
    );
    announce(
      r.changed === 0
        ? "Clip's too short to split."
        : `Split the clip at ${formatSec(mid)}.`
    );
  }

  // ───── Reset active-source clips ────────────────────────────────
  function doReset() {
    if (!hasActive) return;
    const r = resetActive();
    logManual(
      "manual.reset",
      { sourceId: activeSourceId, changed: r.changed },
      `Cleared ${r.changed} clip${r.changed === 1 ? "" : "s"} from "${activeName}"`
    );
    announce(
      r.changed === 0
        ? "No clips to clear on this source."
        : `Cleared ${r.changed} clip${r.changed === 1 ? "" : "s"} from "${activeName}". Other sources are untouched.`
    );
  }

  if (!hasActive) {
    return (
      <div className={styles.toolbar}>
        <span className={styles.empty}>
          Manual edits work once you upload a video.
        </span>
      </div>
    );
  }

  return (
    <div className={styles.toolbar}>
      <span className={styles.label}>Tinker</span>

      {/* Trim first */}
      <div className={styles.group}>
        <Scissors size={13} className="muted" />
        <span className={styles.dim}>Trim first</span>
        <button
          className={styles.btn}
          onClick={() => doTrimFirst(15)}
          title="Drop or shorten clips falling inside the first 15s"
        >
          15s
        </button>
        <button className={styles.btn} onClick={() => doTrimFirst(30)}>
          30s
        </button>
        <button className={styles.btn} onClick={() => doTrimFirst(60)}>
          1m
        </button>
      </div>

      {/* Trim last */}
      <div className={styles.group}>
        <TimerReset size={13} className="muted" />
        <span className={styles.dim}>Trim last</span>
        <button
          className={styles.btn}
          onClick={() => doTrimLast(15)}
          disabled={activeDuration < 15}
          title="Drop or shorten clips falling inside the last 15s"
        >
          15s
        </button>
        <button
          className={styles.btn}
          onClick={() => doTrimLast(30)}
          disabled={activeDuration < 30}
        >
          30s
        </button>
        <button
          className={styles.btn}
          onClick={() => doTrimLast(60)}
          disabled={activeDuration < 60}
        >
          1m
        </button>
      </div>

      {/* Keep / drop range */}
      <div className={styles.group}>
        <Crop size={13} className="muted" />
        <input
          className={styles.timeInput}
          value={rangeStart}
          onChange={(e) => setRangeStart(e.target.value)}
          placeholder="0:00"
          aria-label="Range start"
        />
        <span className={styles.dim}>to</span>
        <input
          className={styles.timeInput}
          value={rangeEnd}
          onChange={(e) => setRangeEnd(e.target.value)}
          placeholder="0:30"
          aria-label="Range end"
        />
        <button
          className={styles.btn}
          onClick={doKeepRange}
          title="Replace active-source clips with one clip [start, end]"
        >
          Keep
        </button>
        <button
          className={`${styles.btn} ${styles.danger}`}
          onClick={doDropRange}
          title="Drop or split clips overlapping [start, end]"
        >
          Drop
        </button>
      </div>

      {/* Split + Reset */}
      <div className={styles.group}>
        <button
          className={styles.btn}
          onClick={doSplit}
          disabled={!selectedClipId}
          title="Split the selected clip in half"
        >
          <SplitSquareHorizontal size={13} />
          Split
        </button>
        <button
          className={`${styles.btn} ${styles.danger}`}
          onClick={doReset}
          title="Clear every clip from the active source. Other sources stay."
        >
          <Trash2 size={13} />
          Reset
        </button>
      </div>

      <span className={styles.dim} style={{ marginLeft: "auto" }}>
        <Sparkles size={11} style={{ verticalAlign: -1, marginRight: 3 }} />
        AI sees these edits next turn
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------
// Time parsing
// ---------------------------------------------------------------------

/**
 * Lenient mm:ss / "1m30s" / "90" parser. Returns seconds (number) or
 * null on completely unrecoverable input. We're permissive on purpose —
 * the toolbar is for tinkering and being strict here is more annoying
 * than safe.
 */
export function parseTimeInput(raw: string): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  // Plain seconds.
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = parseFloat(s);
    return isFinite(n) ? n : null;
  }
  // mm:ss or hh:mm:ss
  if (/^\d+:\d{1,2}(:\d{1,2})?(\.\d+)?$/.test(s)) {
    const parts = s.split(":").map(Number);
    if (parts.some((x) => !isFinite(x))) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  // 1m30s / 90s / 2m
  const m = s.match(/^(?:(\d+)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?$/);
  if (m && (m[1] || m[2])) {
    const mins = m[1] ? parseInt(m[1], 10) : 0;
    const secs = m[2] ? parseFloat(m[2]) : 0;
    return mins * 60 + secs;
  }
  return null;
}

function formatSec(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m === 0) return `${s}s`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

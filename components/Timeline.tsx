"use client";

import { useMemo, useRef, useState } from "react";
import { useEditorStore } from "@/hooks/useEditorStore";
import { formatTime } from "@/lib/util/time";
import { logUser } from "@/lib/log/recorders";
import { SOURCE_COLORS } from "@/lib/config";
import { TransitionsBar } from "./TransitionsBar";
import styles from "./Timeline.module.css";

type DragMode = "move" | "resize-l" | "resize-r" | null;

interface DragState {
  id: string;
  mode: DragMode;
  startX: number;
  origStart: number;
  origEnd: number;
}

/**
 * Multi-source-aware timeline. v1.6.0.
 *
 * The track itself still shows a single source's worth of horizontal
 * space at a time — laying every source's worth side-by-side hurts
 * legibility on small screens. Instead we show a row of source tabs
 * above the track when there's more than one source, and the active
 * tab decides which source's clips are visible. Other sources' clips
 * are kept in state untouched.
 *
 * Each clip gets a small color-coded "S1"/"S2"/… badge tinted to match
 * its source's library color so when the user does cross-source mixes
 * (an upcoming v1.6.x feature) they can tell at a glance which input
 * each clip came from. Today, with a single visible source per tab,
 * the badge is mostly affordance — preparing the eye for the multi-
 * source preview pane that already swaps source on click.
 */
export function Timeline() {
  const highlights = useEditorStore((s) => s.highlights);
  const sources = useEditorStore((s) => s.sources);
  const missingSources = useEditorStore((s) => s.missingSources);
  const activeSourceId = useEditorStore((s) => s.activeSourceId);
  const setActiveSource = useEditorStore((s) => s.setActiveSource);
  const updateHighlight = useEditorStore((s) => s.updateHighlight);
  const selectClip = useEditorStore((s) => s.selectClip);
  const selectedId = useEditorStore((s) => s.selectedClipId);
  const sessionId = useEditorStore((s) => s.sessionId);
  const videoMeta = useEditorStore((s) => s.videoMeta);

  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  // v2.1 — a stable, source-order list combining hydrated sources and
  // restored-but-missing placeholders. Sorted by addedAt so the S-number
  // and color of a source don't jump when it is re-uploaded (hydrated).
  const allSources = useMemo(() => {
    const combined = [
      ...sources.map((s) => ({
        id: s.id,
        meta: s.meta,
        addedAt: s.addedAt,
        missing: false
      })),
      ...missingSources.map((p) => ({
        id: p.id,
        meta: p.meta,
        addedAt: p.addedAt,
        missing: true
      }))
    ];
    return combined.sort((a, b) => a.addedAt - b.addedAt);
  }, [sources, missingSources]);

  const missingIdSet = useMemo(
    () => new Set(missingSources.map((p) => p.id)),
    [missingSources]
  );

  // Resolve a per-source color map once per render. Combined order
  // determines the index — stable across hydration for a session.
  const colorById = useMemo(() => {
    const m = new Map<string, string>();
    allSources.forEach((s, i) => {
      m.set(s.id, SOURCE_COLORS[i % SOURCE_COLORS.length]);
    });
    return m;
  }, [allSources]);

  const indexById = useMemo(() => {
    const m = new Map<string, number>();
    allSources.forEach((s, i) => m.set(s.id, i + 1));
    return m;
  }, [allSources]);

  // Scope visible clips to the active source. Older single-source
  // sessions have highlights without a sourceId — those still belong
  // to whatever the active source is, so include them.
  const visibleHighlights = useMemo(
    () =>
      highlights.filter(
        (h) => !h.sourceId || h.sourceId === activeSourceId
      ),
    [highlights, activeSourceId]
  );

  const activeEntry = allSources.find((s) => s.id === activeSourceId) ?? null;
  const duration =
    activeEntry?.meta.duration ??
    videoMeta?.duration ??
    Math.max(...visibleHighlights.map((h) => h.end), 60);

  const totalSelected = useMemo(
    () => visibleHighlights.reduce((acc, h) => acc + (h.end - h.start), 0),
    [visibleHighlights]
  );

  const totalAcrossLibrary = useMemo(
    () => highlights.reduce((acc, h) => acc + (h.end - h.start), 0),
    [highlights]
  );

  function pxToSec(deltaPx: number): number {
    const w = trackRef.current?.clientWidth ?? 1;
    return (deltaPx / w) * duration;
  }

  function onMouseDown(
    e: React.PointerEvent<HTMLDivElement>,
    h: { id: string; start: number; end: number },
    mode: NonNullable<DragMode>
  ) {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({
      id: h.id,
      mode,
      startX: e.clientX,
      origStart: h.start,
      origEnd: h.end
    });
    selectClip(h.id);
  }

  function onMouseMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag) return;
    const deltaSec = pxToSec(e.clientX - drag.startX);
    if (drag.mode === "move") {
      const len = drag.origEnd - drag.origStart;
      const start = Math.max(0, Math.min(duration - len, drag.origStart + deltaSec));
      updateHighlight(drag.id, { start, end: start + len });
    } else if (drag.mode === "resize-l") {
      const start = Math.max(0, Math.min(drag.origEnd - 0.5, drag.origStart + deltaSec));
      updateHighlight(drag.id, { start });
    } else if (drag.mode === "resize-r") {
      const end = Math.max(drag.origStart + 0.5, Math.min(duration, drag.origEnd + deltaSec));
      updateHighlight(drag.id, { end });
    }
  }

  function onMouseUp(e: React.PointerEvent<HTMLDivElement>) {
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    if (drag) {
      const current = useEditorStore.getState().highlights.find((h) => h.id === drag.id);
      if (current) {
        const fromStart = drag.origStart;
        const fromEnd = drag.origEnd;
        if (drag.mode === "move" && Math.abs(current.start - fromStart) > 0.05) {
          logUser({
            sessionId,
            kind: "clip.moved",
            payload: {
              clipId: drag.id,
              from: round2(fromStart),
              to: round2(current.start),
              delta: round2(current.start - fromStart)
            },
            summary: `Moved clip ${shortId(drag.id)} ${formatDelta(current.start - fromStart)}s`
          });
        } else if (drag.mode === "resize-l" && Math.abs(current.start - fromStart) > 0.05) {
          logUser({
            sessionId,
            kind: "clip.resized",
            payload: {
              clipId: drag.id,
              edge: "left",
              from: round2(fromStart),
              to: round2(current.start)
            },
            summary: `Resized clip ${shortId(drag.id)} left edge ${formatDelta(current.start - fromStart)}s`
          });
        } else if (drag.mode === "resize-r" && Math.abs(current.end - fromEnd) > 0.05) {
          logUser({
            sessionId,
            kind: "clip.resized",
            payload: {
              clipId: drag.id,
              edge: "right",
              from: round2(fromEnd),
              to: round2(current.end)
            },
            summary: `Resized clip ${shortId(drag.id)} right edge ${formatDelta(current.end - fromEnd)}s`
          });
        }
      }
    }
    setDrag(null);
  }

  return (
    <div className={styles.timeline}>
      {/* Source tabs — visible when the project has more than one source
          (hydrated or still-missing). Missing sources are shown so the
          previous arrangement is legible before re-upload. */}
      {allSources.length > 1 && (
        <div className={styles.tabs}>
          {allSources.map((s, i) => {
            const isActive = s.id === activeSourceId;
            const c = SOURCE_COLORS[i % SOURCE_COLORS.length];
            const clipsHere = highlights.filter(
              (h) => (h.sourceId ?? activeSourceId) === s.id
            ).length;
            return (
              <button
                key={s.id}
                className={`${styles.tab} ${isActive ? styles.active : ""}`}
                onClick={() => {
                  setActiveSource(s.id);
                  // v1.6.2 — when the user explicitly switches tab,
                  // pick the first clip on that tab so the preview pane
                  // and ClipInspector update too. If there are no clips
                  // on this source yet, clear selection to avoid a
                  // ghost-selected clip from another source.
                  const onThis = highlights.filter(
                    (h) => (h.sourceId ?? activeSourceId) === s.id
                  );
                  selectClip(onThis[0]?.id ?? null);
                }}
                title={
                  s.missing
                    ? `"${s.meta.name}" is missing — re-upload to restore`
                    : `Switch the timeline to "${s.meta.name}"`
                }
              >
                <span
                  className={styles.tabDot}
                  style={{ background: s.missing ? "var(--warn)" : c }}
                  aria-hidden
                />
                S{i + 1}
                {s.missing && (
                  <span title="source missing" aria-label="source missing">
                    {"\u26A0"}
                  </span>
                )}
                <span className="muted mono" style={{ fontSize: 10 }}>
                  {clipsHere > 0 ? `(${clipsHere})` : ""}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className={styles.header}>
        <span className="muted">
          {visibleHighlights.length} clip{visibleHighlights.length === 1 ? "" : "s"}
        </span>
        <span className="muted">·</span>
        <span className="muted">{formatTime(totalSelected)} on this source</span>
        {allSources.length > 1 && (
          <>
            <span className="muted">·</span>
            <span className="faint">
              {formatTime(totalAcrossLibrary)} across library
            </span>
          </>
        )}
        <div className="spacer" />
        <span className="faint">Source: {formatTime(duration)}</span>
      </div>

      <div
        ref={trackRef}
        className={styles.track}
        onPointerMove={onMouseMove}
        onPointerUp={onMouseUp}
        onPointerCancel={onMouseUp}
      >
        {visibleHighlights.length === 0 && (
          <p className={`faint ${styles.empty}`}>
            No clips on this source. Send the assistant a request, or use
            the manual edit tools.
          </p>
        )}

        {visibleHighlights.map((h) => {
          const left = (h.start / duration) * 100;
          const width = ((h.end - h.start) / duration) * 100;
          const selected = selectedId === h.id;
          const sid = h.sourceId ?? activeSourceId ?? "";
          const color = colorById.get(sid) ?? "#9ECE6A";
          const idx = indexById.get(sid) ?? 1;
          const isMissing = missingIdSet.has(sid);
          return (
            <div
              key={h.id}
              className={`${styles.clip} ${selected ? styles.selected : ""} ${isMissing ? styles.clipMissing : ""}`}
              style={{
                left: `${left}%`,
                width: `${width}%`,
                background: `linear-gradient(180deg,
                  color-mix(in srgb, ${color} 50%, transparent),
                  color-mix(in srgb, ${color} 22%, transparent))`,
                borderColor: `color-mix(in srgb, ${color} 70%, transparent)`
              }}
              onPointerDown={(e) => {
                // Missing-source clips can't be dragged/resized (no media
                // to scrub against) — they're shown for arrangement only.
                if (!isMissing) onMouseDown(e, h, "move");
              }}
              onClick={() => selectClip(h.id)}
              role="button"
              tabIndex={0}
              title={isMissing ? "Source missing — re-upload to edit/render" : undefined}
            >
              {!isMissing && (
                <div
                  className={`${styles.handle} ${styles.left}`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onMouseDown(e, h, "resize-l");
                  }}
                />
              )}
              <div className={styles.clipBody}>
                <span className={styles.clipName}>
                  {allSources.length > 1 && (
                    <span
                      className={styles.sourceBadge}
                      style={{ background: isMissing ? "var(--warn)" : color }}
                    >
                      S{idx}
                    </span>
                  )}
                  {h.label ?? "clip"}
                </span>
                {isMissing ? (
                  <span className={`mono ${styles.clipDuration}`}>
                    {"\u26A0"} source missing
                  </span>
                ) : (
                  <span className={`mono ${styles.clipDuration}`}>
                    {(h.end - h.start).toFixed(1)}s
                  </span>
                )}
              </div>
              {!isMissing && (
                <div
                  className={`${styles.handle} ${styles.right}`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onMouseDown(e, h, "resize-r");
                  }}
                />
              )}
            </div>
          );
        })}

        <div className={styles.tickRow}>
          {ticks(duration).map((t) => (
            <span
              key={t}
              className={styles.tick}
              style={{ left: `${(t / duration) * 100}%` }}
            >
              <em>{formatTime(t)}</em>
            </span>
          ))}
        </div>
      </div>

      <TransitionsBar />
    </div>
  );
}

function ticks(duration: number): number[] {
  const target = 8;
  const step = niceStep(duration / target);
  const out: number[] = [];
  for (let t = 0; t <= duration + 0.001; t += step) out.push(Math.round(t));
  return out;
}

function niceStep(raw: number): number {
  const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  for (const c of candidates) if (c >= raw) return c;
  return 600;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatDelta(d: number): string {
  if (Math.abs(d) < 0.05) return "±0.0";
  return d >= 0 ? `+${d.toFixed(1)}` : d.toFixed(1);
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(-6) : id;
}

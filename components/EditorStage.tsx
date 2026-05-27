"use client";

import { useEffect, useMemo, useRef } from "react";
import { useEditorStore } from "@/hooks/useEditorStore";
import { Timeline } from "./Timeline";
import { ClipInspector } from "./ClipInspector";
import { PreviewToolbar } from "./PreviewToolbar";
import { formatTime } from "@/lib/util/time";
import styles from "./EditorStage.module.css";

interface Props {
  onOpenClips: () => void;
  onRender: () => void;
  isRendering: boolean;
}

/**
 * Two-pane preview surface (v1.5.1).
 *
 *   ┌─────────────────────┬─────────────────────┐
 *   │   Combined          │   Selected clip     │
 *   │   (rendered short   │   (source video,    │
 *   │    when ready, else │    seeked + looped  │
 *   │    full source)     │    inside the clip) │
 *   └─────────────────────┴─────────────────────┘
 *   ┌─────────────────────────────────────────────┐
 *   │  Timeline + ClipInspector                  │
 *   └─────────────────────────────────────────────┘
 *
 * Side-by-side on screens ≥ 1400 px, stacked otherwise. Both panes
 * share the source blob URL — browsers reuse the underlying decoded
 * data so the memory hit is minimal.
 *
 * Click a clip on the timeline → the right pane seeks to that clip's
 * start, plays, and loops between [start, end]. The combined pane
 * always holds the rendered montage when one exists, falling back to
 * the full source so the user has something to scrub.
 */
export function EditorStage({ onOpenClips, onRender, isRendering }: Props) {
  const videoUrl = useEditorStore((s) => s.videoUrl);
  const renderedUrl = useEditorStore((s) => s.renderedUrl);
  const highlights = useEditorStore((s) => s.highlights);
  const selectedClipId = useEditorStore((s) => s.selectedClipId);

  const selectedClip = useMemo(
    () => highlights.find((h) => h.id === selectedClipId) ?? null,
    [highlights, selectedClipId]
  );

  const totalSelected = useMemo(
    () => highlights.reduce((acc, h) => acc + (h.end - h.start), 0),
    [highlights]
  );

  // Right-pane <video> ref. We seek + loop it programmatically when the
  // selected clip changes; the user's normal video controls still work
  // in between.
  const clipVideoRef = useRef<HTMLVideoElement | null>(null);

  // Seek + play whenever the selection changes.
  useEffect(() => {
    if (!selectedClip || !clipVideoRef.current) return;
    const v = clipVideoRef.current;
    // Set `currentTime` only after the video has metadata; otherwise
    // the assignment is lost. `seeking` works on most browsers as soon
    // as `loadedmetadata` has fired.
    const seek = () => {
      v.currentTime = selectedClip.start;
      v.play().catch(() => {
        // Autoplay can be blocked even after user gestures in iframes.
        // We just leave the video paused at clip.start; user can hit play.
      });
    };
    if (v.readyState >= 1) {
      seek();
    } else {
      const onMeta = () => {
        v.removeEventListener("loadedmetadata", onMeta);
        seek();
      };
      v.addEventListener("loadedmetadata", onMeta);
      return () => v.removeEventListener("loadedmetadata", onMeta);
    }
  }, [selectedClip?.id, selectedClip?.start, selectedClip?.end, selectedClip]);

  // Loop within [start, end] so the user gets a continuous preview of
  // just the selected clip. We use `timeupdate` (fires ~4Hz) which is
  // enough resolution for clip boundaries; a 50 ms guard avoids the
  // browser's own end-of-stream pause kicking in just before our wrap.
  const onClipTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    if (!selectedClip) return;
    const v = e.currentTarget;
    if (v.currentTime >= selectedClip.end - 0.05) {
      v.currentTime = selectedClip.start;
      if (v.paused) {
        v.play().catch(() => {});
      }
    }
  };

  return (
    <main className={styles.stage}>
      <section className="card">
        <div className="card-header row gap">
          <span>Preview</span>
          <div className="spacer" />
          <PreviewToolbar
            onOpenClips={onOpenClips}
            onRender={onRender}
            isRendering={isRendering}
          />
        </div>
        <div className="card-body">
          <div className={styles.previewSplit}>
            {/* ─── Combined pane ─────────────────────────────────── */}
            <div className={styles.pane}>
              <div className={styles.paneHeader}>
                <span className="eyebrow">
                  {renderedUrl ? "Combined short" : "Source preview"}
                </span>
                <span className="muted mono">
                  {renderedUrl
                    ? `${formatTime(totalSelected)} render`
                    : highlights.length > 0
                      ? `${highlights.length} clip${highlights.length === 1 ? "" : "s"} planned`
                      : "no clips yet"}
                </span>
              </div>
              <div className={styles.videoFrame}>
                {renderedUrl ? (
                  <video
                    key={renderedUrl}
                    src={renderedUrl}
                    className={`preview ${styles.video}`}
                    controls
                    playsInline
                  />
                ) : videoUrl ? (
                  <video
                    key={videoUrl}
                    src={videoUrl}
                    className={`preview ${styles.video}`}
                    controls
                    playsInline
                  />
                ) : (
                  <div className={styles.placeholder}>
                    <p className="muted">No source loaded.</p>
                    <p className="faint">Upload a video in the rail to begin.</p>
                  </div>
                )}
              </div>
            </div>

            {/* ─── Selected clip pane ────────────────────────────── */}
            <div className={styles.pane}>
              <div className={styles.paneHeader}>
                <span className="eyebrow">Selected clip</span>
                {selectedClip ? (
                  <span className="muted mono">
                    {formatTime(selectedClip.start)} → {formatTime(selectedClip.end)}
                    <span className="faint">
                      {" "}
                      · {(selectedClip.end - selectedClip.start).toFixed(1)}s
                    </span>
                  </span>
                ) : (
                  <span className="faint">none</span>
                )}
              </div>
              <div className={styles.videoFrame}>
                {videoUrl && selectedClip ? (
                  <video
                    key={`${videoUrl}#clip`}
                    ref={clipVideoRef}
                    src={videoUrl}
                    className={`preview ${styles.video}`}
                    controls
                    playsInline
                    muted
                    onTimeUpdate={onClipTimeUpdate}
                  />
                ) : (
                  <div className={styles.placeholder}>
                    <p className="muted">
                      {videoUrl
                        ? "Click a clip on the timeline to preview it."
                        : "Upload a video first."}
                    </p>
                    {videoUrl && highlights.length === 0 && (
                      <p className="faint">
                        No clips yet — tell the assistant what kind of short you want.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-header">Timeline</div>
        <div className="card-body">
          <Timeline />
          <ClipInspector />
        </div>
      </section>
    </main>
  );
}

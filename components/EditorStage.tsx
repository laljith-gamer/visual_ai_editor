"use client";

import { useEditorStore } from "@/hooks/useEditorStore";
import { Timeline } from "./Timeline";
import { ClipInspector } from "./ClipInspector";
import { PreviewToolbar } from "./PreviewToolbar";
import styles from "./EditorStage.module.css";

interface Props {
  onOpenClips: () => void;
  onRender: () => void;
  isRendering: boolean;
}

export function EditorStage({ onOpenClips, onRender, isRendering }: Props) {
  const videoUrl = useEditorStore((s) => s.videoUrl);
  const renderedUrl = useEditorStore((s) => s.renderedUrl);

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

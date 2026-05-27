"use client";

import { Maximize2, Film, Play, Download } from "lucide-react";
import { useShare } from "@/hooks/useShare";
import { useEditorStore } from "@/hooks/useEditorStore";

interface Props {
  onOpenClips: () => void;
  onRender: () => void;
  isRendering: boolean;
}

export function PreviewToolbar({ onOpenClips, onRender, isRendering }: Props) {
  const renderedBlob = useEditorStore((s) => s.renderedBlob);
  const videoRef = useEditorStore((s) => s.videoUrl);
  const share = useShare();

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <button className="btn" onClick={onOpenClips}>
        <Film size={14} /> Open clips
      </button>
      <button
        className="btn"
        onClick={() => {
          if (videoRef) {
            const v = document.querySelector("video.preview") as HTMLVideoElement | null;
            v?.requestFullscreen?.();
          }
        }}
      >
        <Maximize2 size={14} /> Full
      </button>
      <div className="spacer" />
      <button
        className="btn primary"
        onClick={onRender}
        disabled={isRendering}
      >
        <Play size={14} /> {isRendering ? "Rendering…" : "Render"}
      </button>
      {renderedBlob && (
        <button
          className="btn"
          onClick={() =>
            void share({
              blob: renderedBlob,
              filename: "shorts-studio.mp4",
              title: "Shorts Studio export"
            })
          }
        >
          <Download size={14} /> Export
        </button>
      )}
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { Maximize2, Film, Play, Download } from "lucide-react";
import { useExport } from "@/hooks/useExport";
import { useEditorStore } from "@/hooks/useEditorStore";

interface Props {
  onOpenClips: () => void;
  onRender: () => void;
  isRendering: boolean;
}

export function PreviewToolbar({ onOpenClips, onRender, isRendering }: Props) {
  const renderedBlob = useEditorStore((s) => s.renderedBlob);
  const videoRef = useEditorStore((s) => s.videoUrl);
  const doExport = useExport();
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (msgTimer.current) clearTimeout(msgTimer.current);
    };
  }, []);

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const r = await doExport();
      setExportMsg(r.message);
    } finally {
      setExporting(false);
      if (msgTimer.current) clearTimeout(msgTimer.current);
      // Keep the message visible long enough to read; clear after a while.
      msgTimer.current = setTimeout(() => setExportMsg(null), 8000);
    }
  };

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
      {/* Export is always visible. With no rendered blob it returns a
          "Render first" message rather than silently doing nothing. */}
      <button
        className="btn"
        onClick={() => void handleExport()}
        disabled={exporting}
        title={renderedBlob ? "Download the rendered short" : "Render first, then export"}
      >
        <Download size={14} /> {exporting ? "Exporting…" : "Export"}
      </button>
      {exportMsg && (
        <span className="muted" role="status" style={{ flexBasis: "100%", fontSize: 12 }}>
          {exportMsg}
        </span>
      )}
    </div>
  );
}

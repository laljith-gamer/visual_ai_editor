"use client";

import { useCallback } from "react";
import { useEditorStore } from "@/hooks/useEditorStore";
import { buildExportFilename, shareOrDownload } from "@/lib/util/download";

export interface ExportOutcome {
  ok: boolean;
  /** Human-readable result for chat / toast. Never empty. */
  message: string;
  filename?: string;
  reason?: "no-render" | "blocked" | "cancelled";
}

/**
 * Reliable system export of the rendered short.
 *
 * Reads the in-memory rendered blob + session title from the store, builds
 * the deterministic filename, and triggers a direct browser/system download.
 * It intentionally does not use the Web Share sheet: Export means save file.
 */
export function useExport() {
  return useCallback(async (): Promise<ExportOutcome> => {
    const s = useEditorStore.getState();
    if (!s.renderedBlob) {
      return {
        ok: false,
        reason: "no-render",
        message: "Render the short first, then you can export it."
      };
    }
    const filename = buildExportFilename(s.title);
    const res = await shareOrDownload({
      blob: s.renderedBlob,
      filename,
      title: "Shorts Studio export"
    });
    if (res.downloaded) return { ok: true, filename, message: `Saved ${filename} to your downloads.` };
    if (res.cancelled) return { ok: false, reason: "cancelled", message: "Export cancelled." };
    return {
      ok: false,
      reason: "blocked",
      message:
        "Your browser blocked the download. Allow downloads/pop-ups for this site and try again, or right-click the preview video and choose “Save video as…”."
    };
  }, []);
}

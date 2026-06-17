"use client";

import { useCallback } from "react";
import { shareOrDownload, type DownloadResult } from "@/lib/util/download";

interface ShareArgs {
  blob: Blob;
  filename: string;
  title?: string;
  text?: string;
}

/**
 * Wraps the Web Share API with a graceful download fallback. Thin wrapper
 * around `shareOrDownload` (lib/util/download.ts) so share + export reuse
 * one tested code path.
 */
export function useShare() {
  return useCallback(
    (args: ShareArgs): Promise<DownloadResult> => shareOrDownload(args),
    []
  );
}

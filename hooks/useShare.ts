"use client";

import { useCallback } from "react";

interface ShareArgs {
  blob: Blob;
  filename: string;
  title?: string;
  text?: string;
}

/**
 * Wraps navigator.share with a graceful fallback: if the platform doesn't
 * support sharing files, we trigger a download instead.
 */
export function useShare() {
  return useCallback(async ({ blob, filename, title, text }: ShareArgs) => {
    const file = new File([blob], filename, { type: blob.type || "video/mp4" });

    const nav = navigator as Navigator & {
      canShare?: (data: { files: File[] }) => boolean;
      share?: (data: { files: File[]; title?: string; text?: string }) => Promise<void>;
    };

    if (nav.share && nav.canShare?.({ files: [file] })) {
      try {
        await nav.share({ files: [file], title, text });
        return { shared: true };
      } catch (err) {
        if ((err as DOMException).name === "AbortError") return { shared: false };
      }
    }

    // Fallback: download.
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return { shared: false, downloaded: true };
  }, []);
}

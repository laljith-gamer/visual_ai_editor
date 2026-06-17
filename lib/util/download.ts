/**
 * PR 57 — reusable download/export helper.
 *
 * Two layers:
 *   - PURE filename helpers (`safeTitleSegment`, `exportTimestamp`,
 *     `buildExportFilename`) — deterministic, unit-testable in node.
 *   - BROWSER `shareOrDownload` — tries the Web Share API (mobile), then
 *     falls back to an anchor download, and reports whether the platform
 *     BLOCKED the save so the caller can show fallback guidance instead
 *     of silently doing nothing.
 *
 * Deterministic export filename:
 *   shorts-studio-{safe-session-title}-{yyyyMMdd-HHmmss}.mp4
 */

/** Slugify a session title into a filesystem-safe segment. Falls back to
 *  "untitled" when nothing usable remains. ASCII-only so the filename is
 *  safe across operating systems. */
export function safeTitleSegment(title?: string | null): string {
  const slug = (title ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

/** `yyyyMMdd-HHmmss` local-time stamp. */
export function exportTimestamp(date: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/** Build the deterministic export filename. */
export function buildExportFilename(
  title?: string | null,
  date: Date = new Date(),
  ext = "mp4"
): string {
  return `shorts-studio-${safeTitleSegment(title)}-${exportTimestamp(date)}.${ext}`;
}

export interface DownloadResult {
  /** Shared via the Web Share API. */
  shared: boolean;
  /** Saved via an anchor download. */
  downloaded: boolean;
  /** The platform prevented both share and download (show guidance). */
  blocked: boolean;
  /** The user dismissed the share sheet (not an error). */
  cancelled: boolean;
}

interface ShareArgs {
  blob: Blob;
  filename: string;
  title?: string;
  text?: string;
}

/**
 * Share the file if the platform supports sharing files; otherwise trigger
 * a download. Never throws — returns a result the caller can message from.
 */
export async function shareOrDownload({ blob, filename, title, text }: ShareArgs): Promise<DownloadResult> {
  const base: DownloadResult = { shared: false, downloaded: false, blocked: false, cancelled: false };
  if (typeof document === "undefined") {
    return { ...base, blocked: true };
  }

  const file = new File([blob], filename, { type: blob.type || "video/mp4" });
  const nav = navigator as Navigator & {
    canShare?: (data: { files: File[] }) => boolean;
    share?: (data: { files: File[]; title?: string; text?: string }) => Promise<void>;
  };

  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title, text });
      return { ...base, shared: true };
    } catch (err) {
      // User dismissed the share sheet — not an error, and not a download.
      if ((err as DOMException)?.name === "AbortError") {
        return { ...base, cancelled: true };
      }
      // Any other share failure → fall through to the download path.
    }
  }

  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return { ...base, downloaded: true };
  } catch {
    return { ...base, blocked: true };
  }
}

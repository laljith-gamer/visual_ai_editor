/**
 * PR 57 — reusable download/export helper.
 *
 * Two layers:
 *   - PURE filename helpers (`safeTitleSegment`, `exportTimestamp`,
 *     `buildExportFilename`) — deterministic, unit-testable in node.
 *   - BROWSER `shareOrDownload` — despite the historical name, this now
 *     performs a direct system download only. It intentionally does NOT open
 *     the Web Share sheet because the editor's Export button must save the
 *     rendered file, not share it.
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
  /** Always false now: export is download-only, not share. */
  shared: boolean;
  /** Saved via an anchor download. */
  downloaded: boolean;
  /** The platform prevented the download (show guidance). */
  blocked: boolean;
  /** Kept for API compatibility; direct downloads do not use a share sheet. */
  cancelled: boolean;
}

interface ShareArgs {
  blob: Blob;
  filename: string;
  title?: string;
  text?: string;
}

/**
 * Directly download the rendered file using the browser/system save path.
 * The name is kept for compatibility with existing callers, but this function
 * does not call navigator.share.
 */
export async function shareOrDownload({ blob, filename }: ShareArgs): Promise<DownloadResult> {
  const base: DownloadResult = { shared: false, downloaded: false, blocked: false, cancelled: false };
  if (typeof document === "undefined") {
    return { ...base, blocked: true };
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

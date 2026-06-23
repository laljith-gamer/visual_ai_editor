// =====================================================================
// lib/util/stableBlob.ts
//
// Copy a picked File's bytes into a fresh IN-MEMORY Blob at upload time.
//
// WHY: a File from <input type="file"> (or drag-drop) is backed by the
// on-disk file LAZILY — the browser reads the bytes only when you later call
// .arrayBuffer() / read the object URL. If, after the upload, that file is
// moved, renamed, edited, or the OS/browser invalidates the handle, every
// later read throws a DOMException NotReadableError ("The requested file could
// not be read … permission problems"). That breaks BOTH the preview <video>
// and the render/export.
//
// Reading the bytes ONCE here — while the handle is still fresh — detaches the
// stored source from the on-disk file, so preview and render stay reliable for
// the whole session regardless of what happens to the original file.
// =====================================================================

/**
 * Return an in-memory Blob holding a snapshot of `file`'s bytes. If `file` is
 * already a plain in-memory Blob (not a File) it is returned as-is. Throws the
 * underlying read error only if the file is ALREADY unreadable at upload time
 * (the caller surfaces a friendly "couldn't read this file" message).
 */
export async function materializeStableBlob(file: Blob): Promise<Blob> {
  // Only File objects (and blobs backed by a file handle) can go stale. A Blob
  // we built ourselves is already in memory — don't copy it again.
  if (!(typeof File !== "undefined" && file instanceof File)) {
    return file;
  }
  const buf = await file.arrayBuffer();
  return new Blob([buf], { type: file.type || "video/mp4" });
}

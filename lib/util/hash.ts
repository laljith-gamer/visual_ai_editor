/** Web Crypto SHA-256 of a Blob, returned as a hex string.
 *
 * WARNING: this reads the whole blob into memory. Keep it for small blobs and
 * string/cache use-cases; do not use it on multi-GB local videos during upload.
 */
export async function sha256Blob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Lightweight identity for large local files.
 *
 * Browser File handles can throw NotReadableError when an app tries to read a
 * multi-GB file in one arrayBuffer() call. For library de-dupe and transcript
 * cache keys we do not need a cryptographic full-file hash; we need a stable
 * per-file fingerprint that avoids loading the entire video into memory.
 *
 * Strategy:
 * - include metadata when the blob is a File: name, size, lastModified
 * - hash only tiny slices from start / middle / end
 * - if even slice reads fail, fall back to metadata-only identity so the user
 *   can still load the video and work with object URLs
 */
export async function fingerprintLargeBlob(blob: Blob): Promise<string> {
  const file = blob instanceof File ? blob : null;
  const meta = [
    "v2-large-fingerprint",
    file?.name ?? "blob",
    blob.size,
    file?.lastModified ?? 0,
    blob.type ?? ""
  ].join("|");

  const chunkSize = Math.min(1024 * 1024, Math.max(64 * 1024, blob.size));
  const offsets = buildSampleOffsets(blob.size, chunkSize);

  try {
    const pieces: ArrayBuffer[] = [new TextEncoder().encode(meta).buffer];
    for (const start of offsets) {
      const end = Math.min(blob.size, start + chunkSize);
      if (end > start) {
        pieces.push(await blob.slice(start, end).arrayBuffer());
      }
    }
    const joined = concatArrayBuffers(pieces);
    const digest = await crypto.subtle.digest("SHA-256", joined);
    return `sampled:${toHex(digest)}`;
  } catch {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(meta)
    );
    return `metadata:${toHex(digest)}`;
  }
}

/** Use full SHA-256 for small blobs and sampled fingerprint for large ones. */
export async function safeVideoFingerprint(blob: Blob): Promise<string> {
  const fullHashLimitBytes = 256 * 1024 * 1024;
  if (blob.size <= fullHashLimitBytes) {
    try {
      return `sha256:${await sha256Blob(blob)}`;
    } catch {
      return fingerprintLargeBlob(blob);
    }
  }
  return fingerprintLargeBlob(blob);
}

/** SHA-1 of a string (used as scenario signature). */
export async function sha1String(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function buildSampleOffsets(size: number, chunkSize: number): number[] {
  if (size <= 0) return [];
  const starts = [0];
  if (size > chunkSize * 2) {
    starts.push(Math.max(0, Math.floor(size / 2 - chunkSize / 2)));
  }
  if (size > chunkSize) {
    starts.push(Math.max(0, size - chunkSize));
  }
  return Array.from(new Set(starts));
}

function concatArrayBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
  const total = buffers.reduce((sum, b) => sum + b.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of buffers) {
    out.set(new Uint8Array(b), offset);
    offset += b.byteLength;
  }
  return out.buffer;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

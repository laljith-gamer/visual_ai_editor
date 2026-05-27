/**
 * Frame sampling using mediabunny. Returns evenly-spaced JPEG thumbnails
 * downscaled to inferenceWidth. JPEG quality + caps live in lib/config.ts →
 * SAMPLE_DEFAULTS.
 */
import { SAMPLE_DEFAULTS } from "@/lib/config";

export interface SampledFrame {
  /** Timestamp in seconds. */
  t: number;
  /** JPEG-encoded thumbnail blob. */
  blob: Blob;
  /** Decoded width / height of the thumbnail. */
  width: number;
  height: number;
}

export interface SampleOptions {
  /** Period between samples, in seconds. */
  every: number;
  /** Target thumbnail width. Height preserves aspect ratio. */
  width: number;
  /** Maximum number of frames to return. */
  maxFrames?: number;
  /** Progress callback fired periodically (0..1). */
  onProgress?: (p: number) => void;
  /** Optional abort signal. */
  signal?: AbortSignal;
}

/** Lazy import so this module is safe to import server-side as a type ref. */
async function getMediabunny() {
  const mb = await import("mediabunny");
  return mb as unknown as {
    Input: new (opts: { source: unknown; formats?: unknown }) => MBInput;
    BlobSource: new (blob: Blob) => unknown;
    ALL_FORMATS?: unknown;
    CanvasSink: new (track: unknown, opts: { width: number; height: number; poolSize: number }) => MBCanvasSink;
  };
}

interface MBInput {
  getPrimaryVideoTrack(): Promise<MBTrack | null>;
  computeDuration(): Promise<number>;
}

interface MBTrack {
  getCodec(): Promise<string | null>;
  computeDuration(): Promise<number>;
  displayWidth: number;
  displayHeight: number;
}

interface MBCanvasSink {
  getCanvas(t: number): Promise<MBCanvasResult | null>;
}

interface MBCanvasResult {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  timestamp: number;
}

/** Get duration + dimensions without sampling. */
export async function probeVideo(
  blob: Blob
): Promise<{ duration: number; width: number; height: number }> {
  const mb = await getMediabunny();
  const input = new mb.Input({
    source: new mb.BlobSource(blob),
    formats: mb.ALL_FORMATS
  });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("No video track found in source");
  const duration = await input.computeDuration();
  return {
    duration,
    width: track.displayWidth,
    height: track.displayHeight
  };
}

/** Sample frames at regular intervals. */
export async function sampleFrames(
  blob: Blob,
  opts: SampleOptions
): Promise<SampledFrame[]> {
  const mb = await getMediabunny();
  const input = new mb.Input({
    source: new mb.BlobSource(blob),
    formats: mb.ALL_FORMATS
  });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("No video track in source");

  const duration = await input.computeDuration();
  const aspect = track.displayHeight / Math.max(track.displayWidth, 1);
  const width = opts.width;
  const height = Math.max(2, Math.round(width * aspect));

  const sink = new mb.CanvasSink(track, { width, height, poolSize: 2 });

  const timestamps: number[] = [];
  for (let t = 0; t < duration; t += opts.every) {
    timestamps.push(t);
    if (opts.maxFrames && timestamps.length >= opts.maxFrames) break;
  }

  const out: SampledFrame[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const t = timestamps[i];
    const result = await sink.getCanvas(t);
    if (!result) continue;
    const jpeg = await canvasToJpeg(result.canvas, SAMPLE_DEFAULTS.jpegQuality);
    out.push({ t: result.timestamp, blob: jpeg, width, height });
    opts.onProgress?.((i + 1) / timestamps.length);
  }
  return out;
}

async function canvasToJpeg(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  quality: number
): Promise<Blob> {
  if ("convertToBlob" in canvas) {
    return await (canvas as OffscreenCanvas).convertToBlob({
      type: "image/jpeg",
      quality
    });
  }
  return await new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/jpeg",
      quality
    );
  });
}

/** Convert a Blob to base64 (no data: prefix). */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

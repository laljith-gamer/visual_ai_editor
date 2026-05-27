/**
 * Frame sampling using mediabunny. Returns evenly-spaced JPEG thumbnails
 * downscaled to inferenceWidth, plus two zero-cost visual signals
 * computed in the same canvas pass:
 *
 *   - motion:   per-frame pixel difference vs the previous sample.
 *               Captures "something changed on screen" without needing
 *               a model. Brightness-only, strided. Output 0..1.
 *   - saliency: histogram entropy of brightness for the current frame.
 *               Captures visual variety / "is this frame busy or flat".
 *               Output 0..1 (max entropy of 16 bins is log2(16)=4).
 *
 * Both signals are pure JS math on the canvas pixels. They cost roughly
 * 1 ms per frame at 256px and turn the visual pipeline from
 * "semantic-only" into a multi-signal composite — which is what makes
 * "best part" queries actually rank without specific scenarios.
 *
 * JPEG quality + sampling caps live in lib/config.ts.
 */
import { SAMPLE_DEFAULTS, SIGNAL_DEFAULTS } from "@/lib/config";

export interface SampledFrame {
  /** Timestamp in seconds. */
  t: number;
  /** JPEG-encoded thumbnail blob. */
  blob: Blob;
  /** Decoded width / height of the thumbnail. */
  width: number;
  height: number;
  /** Pixel-difference vs the previous frame. 0 for the first frame. 0..1. */
  motion: number;
  /** Brightness-histogram entropy of THIS frame. 0..1. */
  saliency: number;
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
  /** When set, only sample frames inside [startSeconds, endSeconds].
   *  v1.5.0: enables time-bound queries to skip scoring outside the range. */
  range?: { startSeconds: number; endSeconds: number };
}

/** Lazy import so this module is safe to import server-side as a type ref. */
async function getMediabunny() {
  const mb = await import("mediabunny");
  return mb as unknown as {
    Input: new (opts: { source: unknown; formats?: unknown }) => MBInput;
    BlobSource: new (blob: Blob) => unknown;
    ALL_FORMATS?: unknown;
    CanvasSink: new (
      track: unknown,
      opts: {
        width: number;
        height: number;
        poolSize: number;
        /** Required by mediabunny when both width and height are specified. */
        fit: "fill" | "contain" | "cover";
      }
    ) => MBCanvasSink;
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

  // mediabunny throws "options.fit must also be provided" when both width
  // and height are passed without a fit mode. We pre-compute height to match
  // source aspect, so "fill" is exact (no stretching).
  const sink = new mb.CanvasSink(track, {
    width,
    height,
    fit: "fill",
    poolSize: 2
  });

  const rangeStart = opts.range ? Math.max(0, opts.range.startSeconds) : 0;
  const rangeEnd = opts.range
    ? Math.min(duration, opts.range.endSeconds)
    : duration;

  const timestamps: number[] = [];
  for (let t = rangeStart; t < rangeEnd; t += opts.every) {
    timestamps.push(t);
    if (opts.maxFrames && timestamps.length >= opts.maxFrames) break;
  }

  const out: SampledFrame[] = [];
  let prevPixels: Uint8ClampedArray | null = null;
  const stride = SIGNAL_DEFAULTS.pixelStride;
  const motionGain = SIGNAL_DEFAULTS.motionGain;

  for (let i = 0; i < timestamps.length; i++) {
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const t = timestamps[i];
    const result = await sink.getCanvas(t);
    if (!result) continue;

    // Compute motion + saliency before encoding the JPEG so we don't
    // double-touch the canvas. Failure modes default to 0 — we'd rather
    // ship the frame without signals than abort the whole pipeline.
    let motion = 0;
    let saliency = 0;
    let pixels: Uint8ClampedArray | null = null;
    try {
      pixels = readCanvasPixels(result.canvas);
      if (pixels) {
        if (prevPixels && prevPixels.length === pixels.length) {
          motion = computeMotion(prevPixels, pixels, stride, motionGain);
        }
        saliency = computeSaliency(pixels, stride);
      }
    } catch {
      // Pixel readback can fail (taint, missing 2d ctx). Stay at 0.
    }

    const jpeg = await canvasToJpeg(result.canvas, SAMPLE_DEFAULTS.jpegQuality);
    out.push({
      t: result.timestamp,
      blob: jpeg,
      width,
      height,
      motion,
      saliency
    });

    prevPixels = pixels;
    opts.onProgress?.((i + 1) / timestamps.length);
  }
  return out;
}

// ---------------------------------------------------------------------
// Visual-signal helpers (pure, no models, no I/O)
// ---------------------------------------------------------------------

function readCanvasPixels(
  canvas: HTMLCanvasElement | OffscreenCanvas
): Uint8ClampedArray | null {
  // OffscreenCanvas.getContext("2d") returns OffscreenCanvasRenderingContext2D
  // which also exposes getImageData. Fall through silently if unavailable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = (canvas as any).getContext?.("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) return null;
  const w = (canvas as HTMLCanvasElement | OffscreenCanvas).width;
  const h = (canvas as HTMLCanvasElement | OffscreenCanvas).height;
  return ctx.getImageData(0, 0, w, h).data;
}

/** Mean absolute brightness difference between two RGBA frame buffers. */
function computeMotion(
  prev: Uint8ClampedArray,
  curr: Uint8ClampedArray,
  stride: number,
  gain: number
): number {
  let totalDiff = 0;
  let n = 0;
  // Each pixel = 4 bytes (RGBA). Stride 4 = 1 of every 4 pixels = 16-byte step.
  const step = 4 * stride;
  for (let i = 0; i < curr.length; i += step) {
    const y1 = 0.299 * curr[i] + 0.587 * curr[i + 1] + 0.114 * curr[i + 2];
    const y2 = 0.299 * prev[i] + 0.587 * prev[i + 1] + 0.114 * prev[i + 2];
    totalDiff += Math.abs(y1 - y2);
    n++;
  }
  if (n === 0) return 0;
  // Raw mean diff is in [0, 255]. Typical motion ~5-30. Boost by `gain`
  // to use the full 0..1 range, then clamp.
  const raw = totalDiff / n / 255;
  return Math.min(1, raw * gain);
}

/** Shannon entropy of a 16-bin brightness histogram, normalized 0..1. */
function computeSaliency(pixels: Uint8ClampedArray, stride: number): number {
  const histo = new Uint32Array(16);
  let n = 0;
  const step = 4 * stride;
  for (let i = 0; i < pixels.length; i += step) {
    const y =
      (0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]) | 0;
    histo[y >> 4]++;
    n++;
  }
  if (n === 0) return 0;
  let entropy = 0;
  for (let i = 0; i < 16; i++) {
    if (histo[i] === 0) continue;
    const p = histo[i] / n;
    entropy -= p * Math.log2(p);
  }
  // Max entropy for 16 bins is log2(16) = 4.
  return Math.min(1, entropy / 4);
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

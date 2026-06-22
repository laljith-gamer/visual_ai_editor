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
import { SAMPLE_DEFAULTS, SIGNAL_DEFAULTS, REFRAME } from "@/lib/config";

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
  /** Smart-reframe focal point (0..1 fraction). Where motion / visual contrast
   *  sits horizontally / vertically. Defaults to 0.5 (center). */
  focusX: number;
  focusY: number;
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
    let focusX = 0.5;
    let focusY = 0.5;
    let pixels: Uint8ClampedArray | null = null;
    try {
      pixels = readCanvasPixels(result.canvas);
      if (pixels) {
        // Single pass computes both signals; motion only when the previous
        // frame buffer is present and matches dimensions.
        const hasPrev = !!prevPixels && prevPixels.length === pixels.length;
        const signals = computeFrameSignals(
          hasPrev ? prevPixels : null,
          pixels,
          stride,
          motionGain,
          width,
          height
        );
        motion = signals.motion;
        saliency = signals.saliency;
        focusX = signals.focusX;
        focusY = signals.focusY;
      }
    } catch {
      // Pixel readback can fail (taint, missing 2d ctx). Stay at 0 / center.
    }

    const jpeg = await canvasToJpeg(result.canvas, SAMPLE_DEFAULTS.jpegQuality);
    out.push({
      t: result.timestamp,
      blob: jpeg,
      width,
      height,
      motion,
      saliency,
      focusX,
      focusY
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
  // Hint the browser that this context is used for repeated pixel readbacks.
  // If mediabunny already created the 2D context, the option may be ignored;
  // the call is still safe and helps when the context is first created here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = (canvas as any).getContext?.("2d", {
    willReadFrequently: true
  }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return null;
  const w = (canvas as HTMLCanvasElement | OffscreenCanvas).width;
  const h = (canvas as HTMLCanvasElement | OffscreenCanvas).height;
  return ctx.getImageData(0, 0, w, h).data;
}

/**
 * Single-pass computation of both per-frame visual signals.
 *
 * Combines the motion diff (vs `prev`) and the saliency histogram into one
 * loop so the current frame's luminance is derived exactly once instead of
 * twice. The output is identical to the previous two-pass implementation:
 *
 *   - motion:   mean absolute brightness diff vs `prev`, in [0, 255], boosted
 *               by `gain` and clamped to 0..1. Returns 0 when `prev` is null
 *               (e.g. the first frame or a dimension mismatch).
 *   - saliency: Shannon entropy of a 16-bin brightness histogram, normalized
 *               by the max entropy log2(16) = 4, clamped to 0..1.
 *
 * Both signals stride over the same RGBA buffer (4 bytes/pixel).
 */
function computeFrameSignals(
  prev: Uint8ClampedArray | null,
  curr: Uint8ClampedArray,
  stride: number,
  gain: number,
  width: number,
  height: number
): { motion: number; saliency: number; focusX: number; focusY: number } {
  const histo = new Uint32Array(16);
  let totalDiff = 0;
  let n = 0;
  let sumLuma = 0;
  // Motion-weighted focal centroid (accumulated in the same pass — the diff is
  // already computed here, so the centroid is essentially free).
  let mWX = 0;
  let mWY = 0;
  let mW = 0;
  // Each pixel = 4 bytes (RGBA). Stride 4 = 1 of every 4 pixels = 16-byte step.
  const step = 4 * stride;
  const doMotion = prev !== null;
  for (let i = 0; i < curr.length; i += step) {
    const px = i >> 2; // pixel index = i / 4
    const x = px % width;
    const yRow = (px / width) | 0;
    const y = 0.299 * curr[i] + 0.587 * curr[i + 1] + 0.114 * curr[i + 2];
    // Saliency bin: truncate to int (y | 0) then bucket into 16 bins (>> 4).
    histo[(y | 0) >> 4]++;
    sumLuma += y;
    if (doMotion) {
      const yp = 0.299 * prev![i] + 0.587 * prev![i + 1] + 0.114 * prev![i + 2];
      const d = Math.abs(y - yp);
      totalDiff += d;
      mWX += d * x;
      mWY += d * yRow;
      mW += d;
    }
    n++;
  }
  if (n === 0) return { motion: 0, saliency: 0, focusX: 0.5, focusY: 0.5 };

  // Motion: raw mean diff is in [0, 255]. Typical motion ~5-30. Boost by
  // `gain` to use the full 0..1 range, then clamp.
  const motion = doMotion ? Math.min(1, (totalDiff / n / 255) * gain) : 0;

  // Saliency: Shannon entropy of the 16-bin histogram, max entropy log2(16)=4.
  let entropy = 0;
  for (let i = 0; i < 16; i++) {
    if (histo[i] === 0) continue;
    const p = histo[i] / n;
    entropy -= p * Math.log2(p);
  }
  const saliency = Math.min(1, entropy / 4);

  // ---- Focal point ----------------------------------------------------
  // Prefer the MOTION centroid when there's meaningful movement (action /
  // subject moving). Otherwise fall back to a brightness-CONTRAST centroid so
  // a near-static, off-center subject still pulls the crop. Flat frames stay
  // centered. The result is blended toward center (focusStrength) and clamped
  // so the crop never pins to the extreme edge.
  let rawX = 0.5;
  let rawY = 0.5;
  const wDen = Math.max(1, width - 1);
  const hDen = Math.max(1, height - 1);
  if (doMotion && mW > n * REFRAME.motionMassPerPixel) {
    rawX = mWX / mW / wDen;
    rawY = mWY / mW / hDen;
  } else {
    const mean = sumLuma / n;
    let cWX = 0;
    let cWY = 0;
    let cW = 0;
    for (let i = 0; i < curr.length; i += step) {
      const px = i >> 2;
      const x = px % width;
      const yRow = (px / width) | 0;
      const y = 0.299 * curr[i] + 0.587 * curr[i + 1] + 0.114 * curr[i + 2];
      const wgt = Math.abs(y - mean);
      cWX += wgt * x;
      cWY += wgt * yRow;
      cW += wgt;
    }
    if (cW > 0) {
      rawX = cWX / cW / wDen;
      rawY = cWY / cW / hDen;
    }
  }

  const focusX = blendAndClampFocus(rawX);
  const focusY = blendAndClampFocus(rawY);
  return { motion, saliency, focusX, focusY };
}

/** Blend a raw centroid toward center by focusStrength, then clamp to the
 *  safe focal band so the crop never sits on the extreme edge. */
function blendAndClampFocus(raw: number): number {
  if (!isFinite(raw)) return 0.5;
  const blended = 0.5 + (raw - 0.5) * REFRAME.focusStrength;
  return Math.max(REFRAME.minFocus, Math.min(REFRAME.maxFocus, blended));
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
  // Build the binary string in chunks. String.fromCharCode.apply over a
  // sub-array avoids the O(n) re-allocation of per-character `+=` concat
  // (which is costly for full-frame JPEGs) while producing identical output.
  // The chunk size stays well under the argument-count limit of `apply`.
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK) as unknown as number[]
    );
  }
  return btoa(binary);
}
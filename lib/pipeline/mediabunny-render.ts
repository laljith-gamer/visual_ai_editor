"use client";

import { RENDER } from "@/lib/config";
import { computeClipFades, type RenderableTransition } from "@/lib/pipeline/renderFilters";
import type { EditPlan, Highlight, VideoSource } from "@/lib/types";

type RenderFormat = EditPlan["format"];
type RenderTransition = EditPlan["transition"];

interface MediabunnyRenderArgs {
  videoBlob?: Blob;
  sources?: VideoSource[];
  highlights: Highlight[];
  format: RenderFormat;
  transition: RenderTransition;
  /** PR 59 — optional per-boundary renderable transitions (length =
   *  highlights.length; index 0 = lead-in). Overrides the global
   *  `transition` when present. */
  boundaryRenders?: RenderableTransition[];
  onProgress?: (p: number) => void;
}

interface RuntimeSource {
  id: string;
  blob: Blob;
}

interface PreparedSource extends RuntimeSource {
  input: MBInput;
  videoSink: MBVideoSampleSink;
  audioSink: MBAudioSampleSink | null;
}

interface MBRuntime {
  Input: new (opts: { source: unknown; formats?: unknown }) => MBInput;
  BlobSource: new (blob: Blob) => unknown;
  ALL_FORMATS?: unknown;
  Output: new (opts: { format: unknown; target: MBBufferTarget }) => MBOutput;
  BufferTarget: new () => MBBufferTarget;
  Mp4OutputFormat: new (opts?: { fastStart?: false | "in-memory" }) => unknown;
  CanvasSource: new (
    canvas: HTMLCanvasElement | OffscreenCanvas,
    encodingConfig: Record<string, unknown>
  ) => MBCanvasSource;
  AudioSampleSource: new (
    encodingConfig: Record<string, unknown>
  ) => MBAudioSampleSource;
  VideoSampleSink: new (track: unknown) => MBVideoSampleSink;
  AudioSampleSink: new (track: unknown) => MBAudioSampleSink;
  canEncodeVideo: (
    codec: string,
    config?: Record<string, unknown>
  ) => Promise<boolean>;
  canEncodeAudio: (
    codec: string,
    config?: Record<string, unknown>
  ) => Promise<boolean>;
}

interface MBInput {
  getPrimaryVideoTrack(): Promise<MBVideoTrack | null>;
  getPrimaryAudioTrack(): Promise<unknown | null>;
  dispose?: () => void;
}

interface MBVideoTrack {
  displayWidth: number;
  displayHeight: number;
  canDecode?: () => Promise<boolean>;
}

interface MBVideoSampleSink {
  samplesAtTimestamps(
    timestamps: Iterable<number>,
    options?: Record<string, unknown>
  ): AsyncGenerator<MBVideoSample | null, void, unknown>;
}

interface MBAudioSampleSink {
  samples(
    startTimestamp?: number,
    endTimestamp?: number,
    options?: Record<string, unknown>
  ): AsyncGenerator<MBAudioSample, void, unknown>;
}

interface MBVideoSample {
  timestamp: number;
  displayWidth: number;
  displayHeight: number;
  draw(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    dx: number,
    dy: number,
    dWidth?: number,
    dHeight?: number
  ): void;
  close(): void;
}

interface MBAudioSample {
  timestamp: number;
  setTimestamp(newTimestamp: number): void;
  close(): void;
}

interface MBOutput {
  target: MBBufferTarget;
  addVideoTrack(source: MBCanvasSource, metadata?: Record<string, unknown>): void;
  addAudioTrack(
    source: MBAudioSampleSource,
    metadata?: Record<string, unknown>
  ): void;
  start(): Promise<void>;
  finalize(): Promise<void>;
  cancel(): Promise<void>;
}

interface MBCanvasSource {
  add(
    timestamp: number,
    duration?: number,
    encodeOptions?: Record<string, unknown>
  ): Promise<void>;
  close(): void;
}

interface MBAudioSampleSource {
  add(sample: MBAudioSample): Promise<void>;
  close(): void;
}

interface MBBufferTarget {
  buffer: ArrayBuffer | Uint8Array | null;
}

async function getMediabunny(): Promise<MBRuntime> {
  const mb = await import("mediabunny");
  return mb as unknown as MBRuntime;
}

export async function renderWithMediabunny(
  args: MediabunnyRenderArgs
): Promise<Blob> {
  if (typeof window === "undefined") {
    throw new Error("Mediabunny render is browser-only.");
  }
  if (typeof VideoEncoder === "undefined") {
    throw new Error("WebCodecs VideoEncoder is unavailable.");
  }

  const mb = await getMediabunny();
  const dim = outputDimensions(args.format);
  const videoBitrate = videoBitrateFor(dim.w, dim.h);
  const canVideo = await mb.canEncodeVideo("avc", {
    width: dim.w,
    height: dim.h,
    bitrate: videoBitrate
  });
  if (!canVideo) {
    throw new Error("Browser cannot encode AVC MP4 with WebCodecs.");
  }

  const runtimeSources = resolveRuntimeSources(args);
  const prepared = await prepareSources(mb, runtimeSources);
  const sourceById = new Map(prepared.map((s) => [s.id, s]));
  const wantsAudio =
    prepared.length > 0 &&
    args.highlights.every((h) => {
      const sourceId = h.sourceId ?? prepared[0].id;
      return !!sourceById.get(sourceId)?.audioSink;
    });

  const canAudio =
    wantsAudio &&
    typeof AudioEncoder !== "undefined" &&
    (await mb.canEncodeAudio("aac", {
      numberOfChannels: 2,
      sampleRate: 48000,
      bitrate: audioBitrateNumber()
    }));

  if (wantsAudio && !canAudio) {
    cleanupPrepared(prepared);
    throw new Error("Browser cannot encode AAC audio with WebCodecs.");
  }

  const canvas = createCanvas(dim.w, dim.h);
  const ctx = canvas.getContext("2d", {
    alpha: false
  }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) {
    cleanupPrepared(prepared);
    throw new Error("Unable to create render canvas.");
  }

  const target = new mb.BufferTarget();
  const output = new mb.Output({
    format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }),
    target
  });
  const videoSource = new mb.CanvasSource(canvas, {
    codec: "avc",
    bitrate: videoBitrate,
    bitrateMode: "variable",
    hardwareAcceleration: "prefer-hardware",
    latencyMode: "realtime",
    keyFrameInterval: 2
  });
  output.addVideoTrack(videoSource, {
    width: dim.w,
    height: dim.h,
    frameRate: RENDER.fps
  });

  const audioSource = canAudio
    ? new mb.AudioSampleSource({
        codec: "aac",
        bitrate: audioBitrateNumber()
      })
    : null;
  if (audioSource) output.addAudioTrack(audioSource);

  try {
    await output.start();
    await addVideoSamples({
      args,
      prepared,
      sourceById,
      ctx,
      videoSource,
      dim
    });
    videoSource.close();

    if (audioSource) {
      await addAudioSamples({ args, prepared, sourceById, audioSource });
      audioSource.close();
    }

    args.onProgress?.(0.98);
    await output.finalize();
    cleanupPrepared(prepared);
    args.onProgress?.(1);
    return new Blob([bufferTargetBlobPart(target)], { type: "video/mp4" });
  } catch (err) {
    await output.cancel().catch(() => {});
    cleanupPrepared(prepared);
    throw err;
  }
}

async function addVideoSamples(args: {
  args: MediabunnyRenderArgs;
  prepared: PreparedSource[];
  sourceById: Map<string, PreparedSource>;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  videoSource: MBCanvasSource;
  dim: { w: number; h: number };
}): Promise<void> {
  const frameDuration = 1 / RENDER.fps;
  const totalFrames = Math.max(
    1,
    args.args.highlights.reduce(
      (sum, h) => sum + Math.ceil(durationOf(h) * RENDER.fps),
      0
    )
  );
  let outputTime = 0;
  let framesDone = 0;

  // PR 59 — per-clip fade flags (per-boundary when provided, else global).
  const fades = computeClipFades(args.args.highlights.length, {
    transition: args.args.transition,
    boundaryRenders: args.args.boundaryRenders
  });
  let clipIndex = 0;

  for (const h of args.args.highlights) {
    const sourceId = h.sourceId ?? args.prepared[0].id;
    const source = args.sourceById.get(sourceId);
    if (!source) throw new Error(`Missing source ${sourceId} for render.`);

    const clipDuration = durationOf(h);
    const frameCount = Math.max(1, Math.ceil(clipDuration * RENDER.fps));
    const timestamps = frameTimestamps(h.start, frameCount, frameDuration);
    const clipFade = fades[clipIndex] ?? { in: false, out: false };
    let i = 0;

    for await (const sample of source.videoSink.samplesAtTimestamps(
      timestamps
    )) {
      const sampleDuration =
        i === frameCount - 1
          ? Math.max(0.001, clipDuration - frameDuration * i)
          : frameDuration;
      if (sample) {
        paintVideoFrame({
          ctx: args.ctx,
          sample,
          dim: args.dim,
          format: args.args.format,
          focusX: h.focusX,
          focusY: h.focusY,
          alpha: clipAlpha(clipFade, clipDuration, i * frameDuration)
        });
        sample.close();
      } else {
        paintBlack(args.ctx, args.dim);
      }

      await args.videoSource.add(outputTime, sampleDuration, {
        keyFrame: framesDone % Math.max(1, RENDER.fps * 2) === 0
      });

      outputTime += sampleDuration;
      framesDone++;
      i++;
      args.args.onProgress?.(Math.min(0.82, (framesDone / totalFrames) * 0.82));
    }
    clipIndex++;
  }
}

async function addAudioSamples(args: {
  args: MediabunnyRenderArgs;
  prepared: PreparedSource[];
  sourceById: Map<string, PreparedSource>;
  audioSource: MBAudioSampleSource;
}): Promise<void> {
  let outputOffset = 0;
  const totalSeconds = totalHighlightSeconds(args.args.highlights);

  for (const h of args.args.highlights) {
    const sourceId = h.sourceId ?? args.prepared[0].id;
    const source = args.sourceById.get(sourceId);
    const audioSink = source?.audioSink;
    if (!source || !audioSink) {
      outputOffset += durationOf(h);
      continue;
    }

    for await (const sample of audioSink.samples(h.start, h.end)) {
      sample.setTimestamp(outputOffset + Math.max(0, sample.timestamp - h.start));
      await args.audioSource.add(sample);
      sample.close();
    }

    outputOffset += durationOf(h);
    args.args.onProgress?.(
      0.82 + Math.min(0.12, (outputOffset / Math.max(1, totalSeconds)) * 0.12)
    );
  }
}

async function prepareSources(
  mb: MBRuntime,
  sources: RuntimeSource[]
): Promise<PreparedSource[]> {
  const prepared: PreparedSource[] = [];
  try {
    for (const source of sources) {
      const input = new mb.Input({
        source: new mb.BlobSource(source.blob),
        formats: mb.ALL_FORMATS
      });
      const videoTrack = await input.getPrimaryVideoTrack();
      if (!videoTrack) throw new Error("No video track found in source.");
      if (videoTrack.canDecode && !(await videoTrack.canDecode())) {
        throw new Error("Browser cannot decode one of the source videos.");
      }
      const audioTrack = await input.getPrimaryAudioTrack();
      prepared.push({
        ...source,
        input,
        videoSink: new mb.VideoSampleSink(videoTrack),
        audioSink: audioTrack ? new mb.AudioSampleSink(audioTrack) : null
      });
    }
    return prepared;
  } catch (err) {
    cleanupPrepared(prepared);
    throw err;
  }
}

function resolveRuntimeSources(args: MediabunnyRenderArgs): RuntimeSource[] {
  if (args.sources && args.sources.length > 0) {
    const seen = new Set<string>();
    const used: RuntimeSource[] = [];
    for (const h of args.highlights) {
      const id = h.sourceId ?? args.sources[0].id;
      if (seen.has(id)) continue;
      const source = args.sources.find((s) => s.id === id);
      if (!source) {
        throw new Error(`Highlight references missing source ${id}.`);
      }
      seen.add(id);
      used.push({ id, blob: source.blob });
    }
    return used;
  }

  if (!args.videoBlob) {
    throw new Error("render: provide either `sources` or `videoBlob`.");
  }
  return [{ id: "legacy", blob: args.videoBlob }];
}

function paintVideoFrame(args: {
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  sample: MBVideoSample;
  dim: { w: number; h: number };
  format: RenderFormat;
  alpha: number;
  /** v2.7 — smart-reframe focal point (0..1). Positions the crop window for
   *  vertical/square. For horizontal (letterbox) the frame stays centered. */
  focusX?: number;
  focusY?: number;
}) {
  paintBlack(args.ctx, args.dim);
  args.ctx.save();
  args.ctx.globalAlpha = args.alpha;

  const sw = Math.max(1, args.sample.displayWidth);
  const sh = Math.max(1, args.sample.displayHeight);
  const scale =
    args.format === "horizontal"
      ? Math.min(args.dim.w / sw, args.dim.h / sh)
      : Math.max(args.dim.w / sw, args.dim.h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  // Horizontal letterboxes (centered); vertical/square position the crop on
  // the focal point. fx/fy of 0.5 reproduces the original centered crop.
  const fx = args.format === "horizontal" ? 0.5 : clampUnit(args.focusX);
  const fy = args.format === "horizontal" ? 0.5 : clampUnit(args.focusY);
  const dx = (args.dim.w - dw) * fx;
  const dy = (args.dim.h - dh) * fy;
  args.sample.draw(args.ctx, dx, dy, dw, dh);
  args.ctx.restore();
}

function clampUnit(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n)
    ? Math.max(0, Math.min(1, n))
    : 0.5;
}

function paintBlack(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  dim: { w: number; h: number }
) {
  ctx.globalAlpha = 1;
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, dim.w, dim.h);
}

function* frameTimestamps(
  start: number,
  frameCount: number,
  frameDuration: number
): Generator<number> {
  for (let i = 0; i < frameCount; i++) {
    yield start + i * frameDuration;
  }
}

function clipAlpha(
  fade: { in: boolean; out: boolean },
  clipDuration: number,
  localTime: number
): number {
  if (!fade.in && !fade.out) return 1;
  const fadeDuration = Math.min(
    RENDER.fadeMaxSeconds,
    clipDuration * RENDER.fadeFractionOfClip
  );
  if (fadeDuration <= 0) return 1;
  if (fade.in && localTime < fadeDuration) return clamp(localTime / fadeDuration, 0, 1);
  if (fade.out) {
    const remaining = clipDuration - localTime;
    if (remaining < fadeDuration) return clamp(remaining / fadeDuration, 0, 1);
  }
  return 1;
}

function createCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(w, h);
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function outputDimensions(format: RenderFormat): { w: number; h: number } {
  return RENDER.outputDimensions[format] ?? RENDER.outputDimensions.horizontal;
}

function videoBitrateFor(w: number, h: number): number {
  const mp = (w * h) / 1_000_000;
  return Math.round(clamp(mp * RENDER.fps * 80_000, 3_000_000, 10_000_000));
}

function audioBitrateNumber(): number {
  const raw = RENDER.audioBitrate;
  if (raw.endsWith("k")) return Number(raw.slice(0, -1)) * 1000;
  return Number(raw) || 128_000;
}

function bufferTargetBlobPart(target: MBBufferTarget): BlobPart {
  if (!target.buffer) throw new Error("Mediabunny produced an empty output.");
  if (target.buffer instanceof ArrayBuffer) return target.buffer;
  const copy = new Uint8Array(target.buffer.byteLength);
  copy.set(target.buffer);
  return copy.buffer;
}

function durationOf(h: Highlight): number {
  return Math.max(0.001, h.end - h.start);
}

function totalHighlightSeconds(highlights: Highlight[]): number {
  return highlights.reduce((sum, h) => sum + durationOf(h), 0);
}

function cleanupPrepared(sources: PreparedSource[]) {
  for (const source of sources) {
    source.input.dispose?.();
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/// <reference lib="webworker" />
/**
 * ffmpeg.wasm rendering worker. v1.5.1 rewrite.
 *
 * Receives:
 *   { id, type: "init" }
 *   { id, type: "render", videoBytes, highlights, format, transition }
 *
 * Emits progress events ({ type: "progress", progress }) during render
 * and a final { id, payload: Uint8Array } with the encoded MP4.
 *
 * v1.5.1 changes:
 *   - Single ffmpeg.exec() per render. We build ONE filter_complex graph
 *     that does trim → scale → fade → concat for every highlight at once.
 *     Replaces the old N+1 invocation pattern (one full encode per
 *     segment + a concat pass). 3-5x faster end-to-end.
 *   - Switched preset to "ultrafast" + tune=fastdecode. ffmpeg.wasm runs
 *     single-threaded so encoder choice dominates wall time. Trade-off:
 *     ~10-15% larger MP4 output for huge speedup. Acceptable for shorts.
 *   - Continuous progress 0..1 (was N segments × 0..1 in series).
 *
 * All ffmpeg knobs live in lib/config.ts → RENDER. Workers can't reliably
 * import non-relative paths so we keep a parallel local copy mirrored
 * to lib/config.ts. Change one, change the other.
 */
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

// Mirror of lib/config.ts → RENDER. Must match.
const RENDER = {
  ffmpegCoreBaseUrl: "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd",
  fps: 30,
  crf: 23,
  preset: "ultrafast",
  tune: "fastdecode",
  audioBitrate: "128k",
  fadeFractionOfClip: 0.25,
  fadeMaxSeconds: 0.4,
  outputDimensions: {
    vertical: { w: 1080, h: 1920 },
    horizontal: { w: 1920, h: 1080 },
    square: { w: 1080, h: 1080 }
  }
} as const;

interface Highlight {
  id: string;
  start: number;
  end: number;
}

interface InitMessage {
  id: string;
  type: "init";
}
interface RenderMessage {
  id: string;
  type: "render";
  videoBytes: Uint8Array;
  inputName: string;
  highlights: Highlight[];
  format: "vertical" | "horizontal" | "square";
  transition: "none" | "fade" | "crossfade";
}
type Incoming = InitMessage | RenderMessage;

const ffmpeg = new FFmpeg();
let initialized = false;

async function init() {
  if (initialized) return;
  const baseURL = RENDER.ffmpegCoreBaseUrl;
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm")
  });
  ffmpeg.on("progress", ({ progress }) => {
    (self as unknown as Worker).postMessage({ type: "progress", progress });
  });
  initialized = true;
}

self.onmessage = async (e: MessageEvent<Incoming>) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      await init();
      (self as unknown as Worker).postMessage({ id: msg.id, payload: true });
      return;
    }
    if (msg.type === "render") {
      await init();
      const out = await renderShort(msg);
      (self as unknown as Worker).postMessage(
        { id: msg.id, payload: out },
        { transfer: [out.buffer] }
      );
      return;
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: msg.id,
      error: (err as Error).message
    });
  }
};

/**
 * Render in a single ffmpeg call. Builds a filter_complex graph with
 * one trim+scale+fade chain per highlight, then concat=n=N at the end.
 *
 * Audio handling: we try with audio (most common). If the source has
 * no audio track, ffmpeg's `concat=n=*:a=1` will fail. We catch that and
 * retry with the video-only filter graph as a fallback so silent sources
 * still render successfully.
 */
async function renderShort(msg: RenderMessage): Promise<Uint8Array> {
  const inputName = "input.mp4";
  await ffmpeg.writeFile(inputName, msg.videoBytes);

  // First attempt: video + audio path.
  const withAudio = buildArgs(inputName, msg, true);
  let succeeded = false;
  try {
    await ffmpeg.exec(withAudio);
    succeeded = true;
  } catch (err) {
    // Most likely the source had no audio track. Fall through to
    // video-only retry below. Other errors (corrupt input, OOM) will
    // resurface there too.
    void err;
  }

  if (!succeeded) {
    const videoOnly = buildArgs(inputName, msg, false);
    await ffmpeg.exec(videoOnly);
  }

  const data = (await ffmpeg.readFile("output.mp4")) as Uint8Array;

  // Best-effort cleanup; failures here don't matter (next render
  // overwrites these names anyway).
  await Promise.all([
    ffmpeg.deleteFile(inputName).catch(() => {}),
    ffmpeg.deleteFile("output.mp4").catch(() => {})
  ]);

  return data;
}

/** Build the full ffmpeg argv for a single-pass render. */
function buildArgs(
  inputName: string,
  msg: RenderMessage,
  withAudio: boolean
): string[] {
  const filter = buildFilterComplex(msg.highlights, msg.format, msg.transition, withAudio);

  const args: string[] = ["-y", "-i", inputName, "-filter_complex", filter, "-map", "[outv]"];
  if (withAudio) args.push("-map", "[outa]");

  args.push(
    "-c:v",
    "libx264",
    "-preset",
    RENDER.preset,
    "-tune",
    RENDER.tune,
    "-crf",
    String(RENDER.crf),
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(RENDER.fps)
  );

  if (withAudio) {
    args.push("-c:a", "aac", "-b:a", RENDER.audioBitrate);
  } else {
    args.push("-an");
  }

  args.push("-movflags", "+faststart", "output.mp4");
  return args;
}

/** Build the filter_complex graph string for all highlights. */
function buildFilterComplex(
  highlights: Highlight[],
  format: RenderMessage["format"],
  transition: RenderMessage["transition"],
  withAudio: boolean
): string {
  const dim = RENDER.outputDimensions[format] ?? RENDER.outputDimensions.horizontal;
  const scale = scaleExpr(format, dim);
  const fade = transition === "fade" || transition === "crossfade";

  const chains: string[] = [];
  const concatInputs: string[] = [];

  highlights.forEach((h, i) => {
    const dur = Math.max(0.1, h.end - h.start);
    const fadeDur = fade
      ? Math.min(RENDER.fadeMaxSeconds, dur * RENDER.fadeFractionOfClip)
      : 0;

    // Video chain: trim → reset PTS → scale/crop → optional fade.
    let v =
      `[0:v]trim=start=${fmt(h.start)}:end=${fmt(h.end)},` +
      `setpts=PTS-STARTPTS,${scale}`;
    if (fadeDur > 0) {
      v +=
        `,fade=t=in:st=0:d=${fmt(fadeDur)},` +
        `fade=t=out:st=${fmt(dur - fadeDur)}:d=${fmt(fadeDur)}`;
    }
    v += `[v${i}]`;
    chains.push(v);
    concatInputs.push(`[v${i}]`);

    if (withAudio) {
      let a =
        `[0:a]atrim=start=${fmt(h.start)}:end=${fmt(h.end)},` +
        `asetpts=PTS-STARTPTS`;
      if (fadeDur > 0) {
        a +=
          `,afade=t=in:st=0:d=${fmt(fadeDur)},` +
          `afade=t=out:st=${fmt(dur - fadeDur)}:d=${fmt(fadeDur)}`;
      }
      a += `[a${i}]`;
      chains.push(a);
      concatInputs.push(`[a${i}]`);
    }
  });

  const a = withAudio ? 1 : 0;
  const concatOut = withAudio ? `[outv][outa]` : `[outv]`;
  chains.push(
    `${concatInputs.join("")}concat=n=${highlights.length}:v=1:a=${a}${concatOut}`
  );
  return chains.join(";");
}

function scaleExpr(
  format: RenderMessage["format"],
  d: { w: number; h: number }
): string {
  switch (format) {
    case "vertical":
    case "square":
      // Fill the output, then center-crop. Looks best for portrait sources.
      return (
        `scale=${d.w}:${d.h}:force_original_aspect_ratio=increase,` +
        `crop=${d.w}:${d.h}`
      );
    case "horizontal":
    default:
      // Letterbox so widescreen content keeps its full frame.
      return (
        `scale=${d.w}:${d.h}:force_original_aspect_ratio=decrease,` +
        `pad=${d.w}:${d.h}:(ow-iw)/2:(oh-ih)/2:black`
      );
  }
}

/** Tight float formatter — avoids exponential notation in filter strings. */
function fmt(n: number): string {
  return n.toFixed(3);
}

export {};

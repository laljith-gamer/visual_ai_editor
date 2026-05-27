/// <reference lib="webworker" />
/**
 * ffmpeg.wasm rendering worker.
 *
 * Receives:
 *   { id, type: "init" }
 *   { id, type: "render", videoBytes, highlights, format, transition }
 *
 * Emits progress events ({ id, progress }) during render and a final
 * { id, payload: Uint8Array } with the encoded MP4.
 *
 * All ffmpeg knobs (codec settings, output dimensions, fade timing) live
 * in lib/config.ts → RENDER. Workers can't import non-relative paths, so
 * we maintain a parallel local copy that mirrors lib/config.ts. If you
 * change one, change the other.
 */
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

// Mirror of lib/config.ts → RENDER. Web Workers can't reliably resolve the
// "@/" alias because the bundler treats them as separate entry points; the
// canonical config is in lib/config.ts and this duplicate is intentional.
const RENDER = {
  ffmpegCoreBaseUrl: "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd",
  fps: 30,
  crf: 23,
  preset: "veryfast",
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

async function renderShort(msg: RenderMessage): Promise<Uint8Array> {
  const inputName = msg.inputName.endsWith(".mp4") ? msg.inputName : "input.mp4";
  await ffmpeg.writeFile(inputName, msg.videoBytes);

  const segmentNames: string[] = [];
  for (let i = 0; i < msg.highlights.length; i++) {
    const h = msg.highlights[i];
    const segName = `seg_${i}.mp4`;
    const args = buildSegmentArgs(inputName, segName, h, msg);
    await ffmpeg.exec(args);
    segmentNames.push(segName);
  }

  const concatList = segmentNames.map((n) => `file '${n}'`).join("\n");
  await ffmpeg.writeFile("concat.txt", new TextEncoder().encode(concatList));
  await ffmpeg.exec([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    "concat.txt",
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    "output.mp4"
  ]);

  const data = (await ffmpeg.readFile("output.mp4")) as Uint8Array;

  await Promise.all([
    ffmpeg.deleteFile(inputName).catch(() => {}),
    ffmpeg.deleteFile("concat.txt").catch(() => {}),
    ffmpeg.deleteFile("output.mp4").catch(() => {}),
    ...segmentNames.map((n) => ffmpeg.deleteFile(n).catch(() => {}))
  ]);

  return data;
}

function buildSegmentArgs(
  inputName: string,
  segName: string,
  h: Highlight,
  msg: RenderMessage
): string[] {
  const fade = msg.transition === "fade" || msg.transition === "crossfade";
  const dur = Math.max(0.1, h.end - h.start);
  const fadeDur = Math.min(RENDER.fadeMaxSeconds, dur * RENDER.fadeFractionOfClip);

  let vf = scaleFilterFor(msg.format);
  if (fade) {
    vf += `,fade=t=in:st=0:d=${fadeDur},fade=t=out:st=${(dur - fadeDur).toFixed(2)}:d=${fadeDur}`;
  }
  const af = fade
    ? `afade=t=in:st=0:d=${fadeDur},afade=t=out:st=${(dur - fadeDur).toFixed(2)}:d=${fadeDur}`
    : null;

  const args = [
    "-y",
    "-ss",
    h.start.toFixed(3),
    "-to",
    h.end.toFixed(3),
    "-i",
    inputName,
    "-vf",
    vf,
    "-r",
    String(RENDER.fps),
    "-c:v",
    "libx264",
    "-preset",
    RENDER.preset,
    "-crf",
    String(RENDER.crf),
    "-pix_fmt",
    "yuv420p"
  ];
  if (af) args.push("-af", af);
  args.push("-c:a", "aac", "-b:a", RENDER.audioBitrate, "-movflags", "+faststart", segName);
  return args;
}

function scaleFilterFor(format: RenderMessage["format"]): string {
  const d = RENDER.outputDimensions[format] ?? RENDER.outputDimensions.horizontal;
  switch (format) {
    case "vertical":
    case "square":
      // Fill, then center-crop.
      return `scale=${d.w}:${d.h}:force_original_aspect_ratio=increase,crop=${d.w}:${d.h}`;
    case "horizontal":
    default:
      return `scale=${d.w}:${d.h}:force_original_aspect_ratio=decrease,pad=${d.w}:${d.h}:(ow-iw)/2:(oh-ih)/2:black`;
  }
}

export {};

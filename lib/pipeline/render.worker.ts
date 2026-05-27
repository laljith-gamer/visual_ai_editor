/// <reference lib="webworker" />
/**
 * ffmpeg.wasm rendering worker.
 *
 * Receives:
 *   { id, type: "init" }
 *   { id, type: "render", videoBytes: Uint8Array, highlights, format, transition }
 *
 * Emits progress events ({ id, progress }) during render and a final
 * { id, payload: Uint8Array } with the encoded MP4.
 */
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

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
  // Load core from a CDN. Single source of truth so we don't need to commit
  // ~30MB of binaries into the repo.
  const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";
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

  // 1) Trim each highlight into its own segment with -c:v libx264, -c:a aac.
  const segmentNames: string[] = [];
  for (let i = 0; i < msg.highlights.length; i++) {
    const h = msg.highlights[i];
    const segName = `seg_${i}.mp4`;
    const args = buildSegmentArgs(inputName, segName, h, msg);
    await ffmpeg.exec(args);
    segmentNames.push(segName);
  }

  // 2) Build a concat list and concat with -c copy (we already encoded uniformly).
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

  // Cleanup so subsequent renders don't blow memory.
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
  const fadeDur = Math.min(0.4, dur / 4);

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
    "30",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p"
  ];
  if (af) args.push("-af", af);
  args.push("-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", segName);
  return args;
}

function scaleFilterFor(format: RenderMessage["format"]): string {
  switch (format) {
    case "vertical":
      // Scale to fill 1080x1920, then pad/crop center.
      return "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920";
    case "square":
      return "scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080";
    case "horizontal":
    default:
      return "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black";
  }
}

export {};

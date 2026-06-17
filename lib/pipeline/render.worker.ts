/// <reference lib="webworker" />
/**
 * ffmpeg.wasm rendering worker. v1.6.0 multi-source.
 *
 * Receives one of:
 *   { id, type: "init" }
 *   { id, type: "render", inputs: [{ name, bytes }, ...],
 *     highlights: [{ start, end, inputIndex }, ...],
 *     format, transition }
 *
 * Each highlight names the input it pulls from via `inputIndex` so a
 * single render can stitch clips from multiple uploaded sources. For
 * v1.5.x single-source callers, set `inputIndex: 0` for every clip and
 * pass a one-entry `inputs` array — behaviour matches v1.5.1 exactly.
 *
 * Filter graph reads `[N:v]/[N:a]` per highlight and concats them all
 * in one pass. The audio path falls back to video-only when ANY of the
 * sources lacks an audio track (the concat filter's a=1 mode requires
 * every input to have one).
 *
 * Single ffmpeg.exec() per render, ultrafast preset, fastdecode tune.
 * 3-5x faster than the pre-v1.5.1 N+1 invocation pattern.
 */
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";
import {
  buildFilterComplex,
  type RenderableTransition
} from "./renderFilters";

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

interface MultiSourceHighlight {
  id: string;
  start: number;
  end: number;
  /** Index into the `inputs` array. */
  inputIndex: number;
}

interface InputFile {
  name: string;
  bytes: Uint8Array;
}

interface InitMessage {
  id: string;
  type: "init";
}
interface RenderMessage {
  id: string;
  type: "render";
  inputs: InputFile[];
  highlights: MultiSourceHighlight[];
  format: "vertical" | "horizontal" | "square";
  transition: "none" | "fade" | "crossfade";
  /** PR 59 — optional per-boundary renderable transitions (length = clip
   *  count; index 0 = lead-in). When present, overrides the global
   *  `transition`. Already mapped down to none/fade/crossfade by the
   *  caller, so the worker never has to interpret unsupported effects. */
  boundaryRenders?: RenderableTransition[];
}

// v1.5.x compat: single-source render messages still arrive in their
// old shape. We adapt them at runtime to the multi-source format.
interface LegacyRenderMessage {
  id: string;
  type: "render";
  videoBytes: Uint8Array;
  inputName: string;
  highlights: { id: string; start: number; end: number }[];
  format: RenderMessage["format"];
  transition: RenderMessage["transition"];
}

type Incoming = InitMessage | RenderMessage | LegacyRenderMessage;

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
      // Adapt legacy single-source messages to the multi-source schema.
      const adapted: RenderMessage =
        "inputs" in msg
          ? msg
          : {
              id: msg.id,
              type: "render",
              inputs: [{ name: msg.inputName, bytes: msg.videoBytes }],
              highlights: msg.highlights.map((h) => ({
                ...h,
                inputIndex: 0
              })),
              format: msg.format,
              transition: msg.transition
            };
      const out = await renderShort(adapted);
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
 * one trim+scale+fade chain per highlight, referencing the right input
 * by index, then concat=n=N at the end.
 *
 * Audio handling: we try with audio first. When concat fails (missing
 * audio track on any input) we retry with video-only.
 */
async function renderShort(msg: RenderMessage): Promise<Uint8Array> {
  // Write every input file to ffmpeg's virtual FS up front. Names are
  // derived from the index so they're guaranteed unique even if two
  // sources share a basename (`in0.mp4`, `in1.mp4`, …).
  const writtenNames: string[] = [];
  for (let i = 0; i < msg.inputs.length; i++) {
    const fname = `in${i}.mp4`;
    await ffmpeg.writeFile(fname, msg.inputs[i].bytes);
    writtenNames.push(fname);
  }

  // First attempt: video + audio path.
  const withAudio = buildArgs(writtenNames, msg, true);
  let succeeded = false;
  try {
    await ffmpeg.exec(withAudio);
    succeeded = true;
  } catch (err) {
    void err;
  }

  if (!succeeded) {
    const videoOnly = buildArgs(writtenNames, msg, false);
    await ffmpeg.exec(videoOnly);
  }

  const data = (await ffmpeg.readFile("output.mp4")) as Uint8Array;

  // Best-effort cleanup; failures here don't matter (next render
  // overwrites these names anyway).
  await Promise.all([
    ...writtenNames.map((n) => ffmpeg.deleteFile(n).catch(() => {})),
    ffmpeg.deleteFile("output.mp4").catch(() => {})
  ]);

  return data;
}

/** Build the full ffmpeg argv for a single-pass render. */
function buildArgs(
  inputNames: string[],
  msg: RenderMessage,
  withAudio: boolean
): string[] {
  const filter = buildFilterComplex({
    highlights: msg.highlights,
    format: msg.format,
    withAudio,
    transition: msg.transition,
    boundaryRenders: msg.boundaryRenders,
    config: {
      fadeFractionOfClip: RENDER.fadeFractionOfClip,
      fadeMaxSeconds: RENDER.fadeMaxSeconds,
      outputDimensions: RENDER.outputDimensions
    }
  });

  const args: string[] = ["-y"];
  for (const n of inputNames) args.push("-i", n);
  args.push("-filter_complex", filter, "-map", "[outv]");
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

export {};

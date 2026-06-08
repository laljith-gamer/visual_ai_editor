/// <reference lib="webworker" />
/**
 * Frame CAPTIONING worker (image-to-text), in-browser, optional.
 *
 * Loads a transformers.js captioning model once, then for each frame blob
 * returns a short natural-language caption. Two model families are
 * supported behind one protocol:
 *
 *   - ViT-GPT2 ("Xenova/vit-gpt2-image-captioning") via the standard
 *     "image-to-text" pipeline. Lightweight, WASM-friendly.
 *   - Florence-2 ("onnx-community/Florence-2-base") via its task-token
 *     API ("<CAPTION>"). Stronger, needs WebGPU.
 *
 * Communication protocol (mirrors siglip.worker.ts):
 *   { id, type: "init", model: string, task?: string, maxNewTokens?: number }
 *   { id, type: "caption", blob: Blob, t: number }
 *
 * Reply:
 *   { id, payload?: { t, caption } | true, error?: string }
 *
 * This worker NEVER throws to the main thread — on any failure it replies
 * with an `error` string so the caller can degrade gracefully (empty
 * caption, motion+saliency only).
 */
import {
  pipeline,
  env,
  AutoProcessor,
  Florence2ForConditionalGeneration,
  RawImage
} from "@huggingface/transformers";

env.allowLocalModels = false;
env.useBrowserCache = true;

interface InitMessage {
  id: string;
  type: "init";
  model: string;
  /** Florence-2 task token, e.g. "<CAPTION>". Absent → ViT-GPT2 path. */
  task?: string;
  maxNewTokens?: number;
}
interface CaptionMessage {
  id: string;
  type: "caption";
  blob: Blob;
  t: number;
}
type Incoming = InitMessage | CaptionMessage;

// ---- Loaded state ---------------------------------------------------

type ImageToText = (
  image: unknown,
  opts?: Record<string, unknown>
) => Promise<Array<{ generated_text: string }>>;

let mode: "vit" | "florence" | null = null;
let maxNewTokens = 32;
let florenceTask = "<CAPTION>";

// ViT-GPT2 pipeline
let captioner: ImageToText | null = null;

// Florence-2 components
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let flProcessor: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let flModel: any = null;

async function ensureLoaded(msg: InitMessage): Promise<void> {
  if (mode) return;
  maxNewTokens = msg.maxNewTokens ?? 32;
  const isFlorence = /florence/i.test(msg.model);

  if (isFlorence) {
    florenceTask = msg.task ?? "<CAPTION>";
    // Florence-2 uses a dedicated conditional-generation class plus a
    // processor that owns tokenization + post-processing. API per the
    // official onnx-community/Florence-2 model card. device:"webgpu"
    // auto-falls back to wasm.
    flProcessor = await AutoProcessor.from_pretrained(msg.model);
    flModel = await Florence2ForConditionalGeneration.from_pretrained(
      msg.model,
      { device: "webgpu" } as Record<string, unknown>
    );
    mode = "florence";
    return;
  }

  // ViT-GPT2 (and any standard image-to-text repo).
  captioner = (await pipeline("image-to-text", msg.model, {
    device: "webgpu"
  } as Parameters<typeof pipeline>[2]) as unknown) as ImageToText;
  mode = "vit";
}

async function captionBlob(blob: Blob): Promise<string> {
  const image = await RawImage.fromBlob(blob);

  if (mode === "florence") {
    const prompts = flProcessor.construct_prompts(florenceTask);
    const inputs = await flProcessor(image, prompts);
    const ids = await flModel.generate({
      ...inputs,
      max_new_tokens: maxNewTokens,
      num_beams: 1,
      do_sample: false
    });
    // The PROCESSOR owns decode + post-process (not a separate tokenizer).
    const text: string = flProcessor.batch_decode(ids, {
      skip_special_tokens: false
    })[0];
    const parsed = flProcessor.post_process_generation(text, florenceTask, {
      width: image.width,
      height: image.height
    });
    const out = parsed?.[florenceTask];
    return typeof out === "string" ? out.trim() : String(out ?? "").trim();
  }

  // ViT-GPT2 path.
  const result = await captioner!(image, {
    max_new_tokens: maxNewTokens,
    do_sample: false
  });
  return (result?.[0]?.generated_text ?? "").trim();
}

self.onmessage = async (e: MessageEvent<Incoming>) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      await ensureLoaded(msg);
      (self as unknown as Worker).postMessage({ id: msg.id, payload: true });
      return;
    }
    if (msg.type === "caption") {
      if (!mode) throw new Error("caption worker not initialized");
      const caption = await captionBlob(msg.blob);
      (self as unknown as Worker).postMessage({
        id: msg.id,
        payload: { t: msg.t, caption }
      });
      return;
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: msg.id,
      error: (err as Error).message
    });
  }
};

export {};

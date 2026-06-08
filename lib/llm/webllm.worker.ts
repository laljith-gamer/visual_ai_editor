/// <reference lib="webworker" />
/**
 * WebLLM worker.
 *
 * WebLLM ships its own worker-thread handler (WebWorkerMLCEngineHandler),
 * so this file is intentionally tiny: it just forwards messages to the
 * handler. All the heavy lifting (model download, WebGPU inference,
 * OpenAI-compatible chat completions, JSON mode) runs here off the main
 * thread. The main-thread side uses CreateWebWorkerMLCEngine (see
 * lib/llm/engine.ts) which speaks the matching protocol.
 *
 * Pattern is taken verbatim from the official WebLLM "Using Workers"
 * docs, so we don't hand-roll the RPC envelope.
 */
import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm";

const handler = new WebWorkerMLCEngineHandler();

self.onmessage = (msg: MessageEvent) => {
  handler.onmessage(msg);
};

export {};

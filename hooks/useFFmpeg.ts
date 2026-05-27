"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Highlight, EditPlan } from "@/lib/types";

interface RenderArgs {
  videoBlob: Blob;
  highlights: Highlight[];
  format: EditPlan["format"];
  transition: EditPlan["transition"];
  onProgress?: (p: number) => void;
}

interface UseFFmpegResult {
  ready: boolean;
  loading: boolean;
  error: string | null;
  render: (args: RenderArgs) => Promise<Blob>;
}

/**
 * Lazily spins up the ffmpeg.wasm worker on first call to render(). Until
 * then, no wasm is downloaded — this keeps initial page load tiny.
 */
export function useFFmpeg(): UseFFmpegResult {
  const workerRef = useRef<Worker | null>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ensureWorker = useCallback(async () => {
    if (workerRef.current) return workerRef.current;
    setLoading(true);
    setError(null);
    try {
      const worker = new Worker(
        new URL("../lib/pipeline/render.worker.ts", import.meta.url),
        { type: "module" }
      );
      await new Promise<void>((resolve, reject) => {
        const id = "init";
        const onMsg = (e: MessageEvent) => {
          if (e.data?.id !== id) return;
          worker.removeEventListener("message", onMsg);
          if (e.data.error) reject(new Error(e.data.error));
          else resolve();
        };
        worker.addEventListener("message", onMsg);
        worker.postMessage({ id, type: "init" });
      });
      workerRef.current = worker;
      setReady(true);
      return worker;
    } catch (err) {
      setError((err as Error).message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const render = useCallback(
    async (args: RenderArgs): Promise<Blob> => {
      const worker = await ensureWorker();
      const videoBytes = new Uint8Array(await args.videoBlob.arrayBuffer());

      return new Promise<Blob>((resolve, reject) => {
        const id = `render_${Date.now()}`;
        const onMsg = (e: MessageEvent) => {
          if (e.data?.type === "progress") {
            args.onProgress?.(e.data.progress);
            return;
          }
          if (e.data?.id !== id) return;
          worker.removeEventListener("message", onMsg);
          if (e.data.error) reject(new Error(e.data.error));
          else {
            const bytes = e.data.payload as Uint8Array;
            const view = new Uint8Array(bytes);
            const copy = new Uint8Array(view.byteLength);
            copy.set(view);
            resolve(new Blob([copy.buffer], { type: "video/mp4" }));
          }
        };
        worker.addEventListener("message", onMsg);
        worker.postMessage(
          {
            id,
            type: "render",
            videoBytes,
            inputName: "input.mp4",
            highlights: args.highlights,
            format: args.format,
            transition: args.transition
          },
          [videoBytes.buffer]
        );
      });
    },
    [ensureWorker]
  );

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  return { ready, loading, error, render };
}

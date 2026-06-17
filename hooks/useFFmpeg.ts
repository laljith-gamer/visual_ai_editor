"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { renderWithMediabunny } from "@/lib/pipeline/mediabunny-render";
import type { RenderableTransition } from "@/lib/pipeline/renderFilters";
import type { Highlight, EditPlan, VideoSource } from "@/lib/types";

interface RenderArgs {
  /** v1.5.x single-source path. Either this OR `sources` must be set. */
  videoBlob?: Blob;
  /** v1.6.0 multi-source path — every uploaded library entry available
   *  for this render. The hook sends only those whose ids appear in
   *  highlights, in the order they're referenced. */
  sources?: VideoSource[];
  highlights: Highlight[];
  format: EditPlan["format"];
  transition: EditPlan["transition"];
  /** PR 59 — optional per-boundary renderable transitions (length =
   *  highlights.length; index 0 = lead-in). When present, overrides the
   *  global `transition` in both render paths. Already mapped down to
   *  none/fade/crossfade. */
  boundaryRenders?: RenderableTransition[];
  onProgress?: (p: number) => void;
}

interface UseFFmpegResult {
  ready: boolean;
  loading: boolean;
  error: string | null;
  render: (args: RenderArgs) => Promise<Blob>;
}

/**
 * Prefers Mediabunny/WebCodecs for hardware-accelerated export, then
 * lazily spins up ffmpeg.wasm only when fallback is needed.
 *
 * v1.6.0: render() now accepts either a single videoBlob (legacy) or a
 * `sources` library + highlights tagged with `sourceId`. We resolve the
 * minimal set of inputs the worker needs, transfer their bytes, and
 * remap each highlight to an `inputIndex` so the filter graph picks
 * the right `[N:v]/[N:a]`.
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
      try {
        return await renderWithMediabunny(args);
      } catch (mediabunnyErr) {
        console.warn(
          "Mediabunny render unavailable; falling back to ffmpeg.wasm.",
          mediabunnyErr
        );
        args.onProgress?.(0);
      }

      const worker = await ensureWorker();

      // v1.6.0: resolve the minimal set of inputs. If we only have
      // legacy videoBlob, wrap it as a single input. Otherwise pluck
      // each source referenced by highlights[i].sourceId in order of
      // first appearance — the worker will see them as in0.mp4, in1.mp4
      // and the highlight's `inputIndex` selects which one.
      let inputs: { name: string; bytes: Uint8Array }[];
      let mappedHighlights: {
        id: string;
        start: number;
        end: number;
        inputIndex: number;
      }[];
      const transfers: ArrayBuffer[] = [];

      if (args.sources && args.sources.length > 0) {
        const seen = new Map<string, number>();
        const used: { id: string; blob: Blob }[] = [];
        for (const h of args.highlights) {
          const sid = h.sourceId ?? args.sources[0].id;
          if (!seen.has(sid)) {
            const src = args.sources.find((s) => s.id === sid);
            if (!src) {
              throw new Error(
                `Highlight references missing source ${sid}; cannot render.`
              );
            }
            seen.set(sid, used.length);
            used.push({ id: sid, blob: src.blob });
          }
        }
        // Materialise bytes for transfer.
        inputs = await Promise.all(
          used.map(async (u, i) => ({
            name: `in${i}.mp4`,
            bytes: new Uint8Array(await u.blob.arrayBuffer())
          }))
        );
        for (const inp of inputs) transfers.push(inp.bytes.buffer as ArrayBuffer);
        mappedHighlights = args.highlights.map((h) => ({
          id: h.id,
          start: h.start,
          end: h.end,
          inputIndex: seen.get(h.sourceId ?? args.sources![0].id) ?? 0
        }));
      } else if (args.videoBlob) {
        const bytes = new Uint8Array(await args.videoBlob.arrayBuffer());
        inputs = [{ name: "in0.mp4", bytes }];
        transfers.push(bytes.buffer as ArrayBuffer);
        mappedHighlights = args.highlights.map((h) => ({
          id: h.id,
          start: h.start,
          end: h.end,
          inputIndex: 0
        }));
      } else {
        throw new Error("render: provide either `sources` or `videoBlob`.");
      }

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
            inputs,
            highlights: mappedHighlights,
            format: args.format,
            transition: args.transition,
            boundaryRenders: args.boundaryRenders
          },
          transfers
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

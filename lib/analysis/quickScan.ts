// =====================================================================
// lib/analysis/quickScan.ts
//
// Browser-only runner for the bounded "Run a quick local scan" command.
// Samples a few keyframes via the existing mediabunny canvas pass (which
// already computes model-free motion + saliency), reduces them to a compact
// structural memory (PURE summarizeQuickScan), and persists it via the
// VideoMemoryManager so the next prompt can reuse it.
//
// LOCAL-ONLY: no cloud, no SigLIP/WebGPU, no upload, no raw frames kept.
// The frame JPEGs returned by sampleFrames are used only to read the
// (already-computed) signals and are discarded — never persisted.
// =====================================================================

import { planAnalysisBudget } from "./budget";
import { summarizeQuickScan, type QuickScanSummary } from "./quickScanResult";
import { recordVideoMemory } from "./videoMemoryManager";
import type { DeviceTier, VideoAnalysisMemory } from "./types";

export interface QuickScanSource {
  id: string;
  hash: string;
  blob: Blob;
  meta: { name: string; duration: number; width: number; height: number };
}

export interface RunQuickScanArgs {
  source: QuickScanSource;
  deviceTier: DeviceTier;
  /** Deeper (still bounded, still model-free) scan — more keyframes. */
  deep?: boolean;
  onProgress?: (p: number) => void;
}

export interface RunQuickScanResult {
  memory: VideoAnalysisMemory;
  summary: QuickScanSummary;
  frameCount: number;
  maxFrames: number;
}

/**
 * Run a bounded local structural scan of one source and persist a level-1
 * VideoAnalysisMemory. Returns the merged memory + the clarification signals
 * (confidence / candidate strength / content types).
 */
export async function runQuickScan(args: RunQuickScanArgs): Promise<RunQuickScanResult> {
  const { source, deviceTier, deep, onProgress } = args;
  const duration = source.meta.duration;

  // Bounded budget: a quick describe-sized scan, or the (still capped)
  // best-parts band for a deeper scan. Both are model-free here.
  const budget = planAnalysisBudget({
    durationSeconds: duration,
    width: source.meta.width,
    height: source.meta.height,
    sourceCount: 1,
    purpose: deep ? "normal_highlights" : "quick_describe",
    deviceTier,
    hasCachedQuickScan: false,
    hasCachedDeepScan: false,
    promptSpecificity: deep ? "normal" : "simple"
  });

  const maxFrames = Math.max(1, budget.maxFrames || (deep ? 60 : 8));
  const every =
    budget.sampleEverySeconds > 0
      ? budget.sampleEverySeconds
      : Math.max(0.5, duration / maxFrames);

  const { sampleFrames } = await import("@/lib/pipeline/sample");
  const frames = await sampleFrames(source.blob, {
    every,
    width: budget.inferenceWidth || 224,
    maxFrames,
    onProgress
  });

  const { captionFrames } = await import("@/lib/vision/caption");
  const captionResult = await captionFrames(frames, {
    tier: deviceTier === "unknown" ? "low" : deviceTier,
    enabled: true,
  });

  const summary = summarizeQuickScan(
    captionResult.frames.map((f) => ({
      t: f.t,
      motion: f.motion,
      saliency: f.saliency,
      caption: (f as any).caption
    })),
    duration
  );

  const memory = await recordVideoMemory(
    {
      videoHash: source.hash,
      sourceId: source.id,
      sourceName: source.meta.name,
      durationSeconds: duration,
      width: source.meta.width,
      height: source.meta.height
    },
    summary.patch
  );

  return { memory, summary, frameCount: frames.length, maxFrames };
}

// =====================================================================
// lib/analysis/memorySignals.ts
//
// PURE bridge helpers between the stored VideoAnalysisMemory and the rest
// of the dynamic-analysis system. These translate "what we already know
// about a video" into the cache flags the budget planner reads, the level
// to record after a run, and the compact memory PATCH that a finished
// best-parts run leaves behind so the NEXT prompt can reuse it.
//
// PURE: imports types only (no browser APIs, no store). Unit-tested. Keeps
// the idb-backed videoMemoryStore (browser-only) free of decision logic.
// =====================================================================

import type {
  TimeRangeScore,
  VideoAnalysisLevel,
  VideoAnalysisMemory,
  VideoAnalysisMemoryPatch
} from "./types";

/**
 * Map a stored memory to the budget planner's cache flags. The budget
 * planner treats:
 *   - level >= 1 (a quick scan) → a cached quick scan exists.
 *   - level >= 3 (a semantic / deep scan) → a cached deep scan exists.
 * A higher level always implies the lower one. Null memory → no cache.
 */
export function analysisCacheSignals(memory: VideoAnalysisMemory | null | undefined): {
  hasCachedQuickScan: boolean;
  hasCachedDeepScan: boolean;
} {
  if (!memory) return { hasCachedQuickScan: false, hasCachedDeepScan: false };
  return {
    hasCachedQuickScan: memory.level >= 1,
    hasCachedDeepScan: memory.level >= 3
  };
}

/**
 * The analysis level a finished selection run should record. A run that used
 * the local semantic (SigLIP) pass produced level-3 knowledge; a motion/
 * saliency-only run produced a level-2 (scene/structural) read. Never
 * downgrades — the caller merges this with any existing (higher) level.
 */
export function analysisLevelForRun(opts: { hadSemanticPass: boolean }): VideoAnalysisLevel {
  return opts.hadSemanticPass ? 3 : 2;
}

export interface HighlightWindow {
  start: number;
  end: number;
  score: number;
  label?: string;
}

export interface HighlightMemoryPatchArgs {
  durationSeconds: number;
  /** Clips the run kept (the strong windows). */
  highlights: HighlightWindow[];
  /** Max composite score seen across the run (0..1). */
  scoreMax: number;
  /** True when the only matches were below the strong threshold. */
  weakOnly: boolean;
  /** Whether a local semantic pass ran (drives level 2 vs 3). */
  hadSemanticPass: boolean;
  updatedAt?: number;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Build the compact memory patch a best-parts/highlights run leaves behind.
 * It records the kept clips as `knownGoodWindows` (so the next prompt can
 * reuse them without re-scanning), a confidence from the top score, and the
 * analysis level. NO raw frames — windows + scores + a structural summary
 * only. When the run was weak, the windows are recorded as `weakWindows`
 * instead so a later prompt knows the result was inconclusive.
 */
export function buildHighlightMemoryPatch(args: HighlightMemoryPatchArgs): VideoAnalysisMemoryPatch {
  const windows: TimeRangeScore[] = args.highlights
    .filter((h) => h.end > h.start)
    .map((h) => ({
      start: round2(h.start),
      end: round2(h.end),
      score: round2(clamp01(h.score)),
      label: h.label
    }));

  const level = analysisLevelForRun({ hadSemanticPass: args.hadSemanticPass });
  // Confidence: the top composite score, softened a little when the run was
  // weak so a later prompt treats it as inconclusive.
  const confidence = clamp01(args.weakOnly ? args.scoreMax * 0.5 : args.scoreMax);

  const summary =
    windows.length > 0
      ? `${args.hadSemanticPass ? "Semantic" : "Structural"} scan found ${windows.length} strong window${
          windows.length === 1 ? "" : "s"
        }.`
      : "Scan found no strong windows.";

  return {
    level,
    confidence: round2(confidence),
    knownGoodWindows: args.weakOnly ? [] : windows,
    weakWindows: args.weakOnly ? windows : [],
    durationSeconds: args.durationSeconds,
    summary,
    updatedAt: args.updatedAt
  };
}

// =====================================================================
// lib/analysis/videoMemory.ts
//
// Compact, LOCAL video-analysis memory — PURE helpers. The memory remembers
// what we learned about a video (scene map, motion/saliency peaks, good/weak
// windows, level, confidence, role) so a later prompt can REUSE it instead of
// re-scanning. Keyed by `videoHash`, so re-uploading the same file (which
// gets the same hash) reconnects to its memory.
//
// PRIVACY: this NEVER holds raw video bytes or full frame images — only
// derived numbers + a tiny per-keyframe summary. Persistence lives in the
// sibling videoMemoryStore.ts (browser idb-keyval); these helpers are
// dependency-free and unit-testable.
// =====================================================================

import type {
  TimeRangeScore,
  VideoAnalysisLevel,
  VideoAnalysisMemory,
  VideoAnalysisMemoryPatch
} from "./types";

export interface CreateVideoMemoryArgs {
  videoHash: string;
  sourceId: string;
  sourceName: string;
  durationSeconds: number;
  width?: number;
  height?: number;
  /** Defaults to 0 (metadata only). */
  level?: VideoAnalysisLevel;
  /** Defaults to Date.now() at call site — pass for deterministic tests. */
  updatedAt?: number;
}

/** A fresh level-0 (metadata-only) memory for a source. */
export function createVideoMemory(args: CreateVideoMemoryArgs): VideoAnalysisMemory {
  return {
    videoHash: args.videoHash,
    sourceId: args.sourceId,
    sourceName: args.sourceName,
    durationSeconds: args.durationSeconds,
    width: args.width,
    height: args.height,
    updatedAt: args.updatedAt ?? Date.now(),
    level: args.level ?? 0,
    confidence: 0,
    sceneMap: [],
    keyframes: [],
    motionPeaks: [],
    saliencyPeaks: [],
    staticRanges: [],
    knownGoodWindows: [],
    weakWindows: [],
    rejectedWindows: []
  };
}

/**
 * Merge a patch (from a new analysis pass) into an existing memory. A higher
 * analysis level always wins; arrays present in the patch REPLACE the old
 * ones (a re-scan recomputes them); scalars coalesce. Deterministic — the
 * caller sets `updatedAt`.
 */
export function mergeVideoMemory(
  old: VideoAnalysisMemory,
  patch: VideoAnalysisMemoryPatch
): VideoAnalysisMemory {
  const nextLevel = (patch.level ?? old.level) as VideoAnalysisLevel;
  return {
    videoHash: patch.videoHash ?? old.videoHash,
    sourceId: patch.sourceId ?? old.sourceId,
    sourceName: patch.sourceName ?? old.sourceName,
    durationSeconds: patch.durationSeconds ?? old.durationSeconds,
    width: patch.width ?? old.width,
    height: patch.height ?? old.height,
    updatedAt: patch.updatedAt ?? old.updatedAt,
    // A higher level wins; an equal/refresh pass keeps the higher of the two.
    level: Math.max(old.level, nextLevel) as VideoAnalysisLevel,
    confidence: typeof patch.confidence === "number" ? patch.confidence : old.confidence,
    summary: patch.summary ?? old.summary,
    sceneMap: patch.sceneMap ?? old.sceneMap,
    keyframes: patch.keyframes ?? old.keyframes,
    motionPeaks: patch.motionPeaks ?? old.motionPeaks,
    saliencyPeaks: patch.saliencyPeaks ?? old.saliencyPeaks,
    staticRanges: patch.staticRanges ?? old.staticRanges,
    knownGoodWindows: patch.knownGoodWindows ?? old.knownGoodWindows,
    weakWindows: patch.weakWindows ?? old.weakWindows,
    rejectedWindows: patch.rejectedWindows ?? old.rejectedWindows,
    sourceRole: patch.sourceRole ?? old.sourceRole,
    topics: patch.topics ?? old.topics,
    warnings: patch.warnings ?? old.warnings
  };
}

/** True when the stored memory hasn't yet reached the level a request needs. */
export function needsAnalysisLevel(
  memory: VideoAnalysisMemory | null,
  requiredLevel: VideoAnalysisLevel
): boolean {
  if (!memory) return requiredLevel > 0;
  return memory.level < requiredLevel;
}

function avgScore(ranges: TimeRangeScore[]): number {
  if (ranges.length === 0) return 0;
  return ranges.reduce((a, r) => a + r.score, 0) / ranges.length;
}

/** Coarse motion profile derived from motion peaks vs static ranges. */
export function motionProfile(memory: VideoAnalysisMemory): "high" | "low" | "mixed" | "unknown" {
  if (memory.level < 1) return "unknown";
  const motion = avgScore(memory.motionPeaks);
  const hasStatic = memory.staticRanges.length > 0;
  if (motion >= 0.6 && !hasStatic) return "high";
  if (motion <= 0.25 || (hasStatic && memory.motionPeaks.length === 0)) return "low";
  return "mixed";
}

function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/** A short human summary of what we know about this video. */
export function summarizeVideoMemory(memory: VideoAnalysisMemory): string {
  const bits: string[] = [`"${memory.sourceName}" — ${fmtTime(memory.durationSeconds)}`];
  if (memory.width && memory.height) bits.push(`${memory.width}×${memory.height}`);
  bits.push(`scan level ${memory.level}`);
  if (memory.level >= 1) {
    const profile = motionProfile(memory);
    if (profile !== "unknown") bits.push(`${profile} motion`);
  }
  if (memory.sceneMap.length > 0) bits.push(`${memory.sceneMap.length} scenes`);
  if (memory.knownGoodWindows.length > 0) bits.push(`${memory.knownGoodWindows.length} strong window(s)`);
  if (memory.sourceRole) bits.push(`role: ${memory.sourceRole}`);
  if (memory.summary) bits.push(memory.summary);
  return bits.join(", ") + ".";
}

export interface SourcePlanningSummary {
  sourceId: string;
  videoHash: string;
  name: string;
  durationSeconds: number;
  level: VideoAnalysisLevel;
  confidence: number;
  motion: "high" | "low" | "mixed" | "unknown";
  goodWindowCount: number;
  goodWindows: TimeRangeScore[];
  role?: string;
}

/** Reduce a memory to the compact summary the global planner reasons over. */
export function summarizeSourceForPlanning(memory: VideoAnalysisMemory): SourcePlanningSummary {
  return {
    sourceId: memory.sourceId,
    videoHash: memory.videoHash,
    name: memory.sourceName,
    durationSeconds: memory.durationSeconds,
    level: memory.level,
    confidence: memory.confidence,
    motion: motionProfile(memory),
    goodWindowCount: memory.knownGoodWindows.length,
    goodWindows: memory.knownGoodWindows,
    role: memory.sourceRole
  };
}

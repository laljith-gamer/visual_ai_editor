import type {
  CandidateWindow,
  EditPlan,
  FrameScore,
  ScoreStats,
  UserTier
} from "@/lib/types";
import { clamp } from "@/lib/util/time";
import { EVENT_DETECTION } from "@/lib/config";
import {
  computeScoreStats,
  deriveCandidatePercentile,
  deriveMinClipSeconds
} from "@/lib/pipeline/adapt";

export interface DetectionResult {
  windows: CandidateWindow[];
  stats: ScoreStats;
  cutoff: number;
  percentile: number;
  minClipSeconds: number;
}

export interface DetectionOptions {
  userTier?: UserTier;
  videoMeta?: { duration: number; width: number; height: number };
}

/**
 * v1.3.0: Percentile-based candidate detection. Replaces the hardcoded
 * 0.15 threshold floor with an adaptive cutoff derived from user tier,
 * selection strategy, and the actual score distribution.
 */
export function detectCandidateWindows(
  frames: FrameScore[],
  plan: EditPlan,
  options: DetectionOptions = {}
): DetectionResult {
  if (frames.length === 0) {
    return {
      windows: [],
      stats: { count: 0, max: 0, mean: 0, p50: 0, p75: 0, p90: 0 },
      cutoff: 0,
      percentile: 0,
      minClipSeconds: plan.minClipSeconds
    };
  }

  const sorted = [...frames].sort((a, b) => a.t - b.t);
  const scores = sorted.map((f) => f.score);
  const stats = computeScoreStats(scores);

  const ctx = {
    plan,
    videoMeta: options.videoMeta,
    scoreStats: stats,
    userTier: options.userTier
  };
  const percentile = deriveCandidatePercentile(ctx);
  const minClip = deriveMinClipSeconds(ctx);

  // Cutoff = score at the (percentile)-th position in descending order.
  const sortedDesc = [...scores].sort((a, b) => b - a);
  const cutoffIdx = Math.max(0, Math.floor(scores.length * percentile) - 1);
  const cutoff = sortedDesc[cutoffIdx] ?? 0;

  const windows: CandidateWindow[] = [];
  let cursor: FrameScore[] = [];

  const flush = () => {
    if (cursor.length === 0) return;
    const start = cursor[0].t;
    const end = cursor[cursor.length - 1].t + plan.sampleEverySeconds;
    const meanScore =
      cursor.reduce((acc, f) => acc + f.score, 0) / cursor.length;
    const duration = end - start;
    if (duration >= minClip * EVENT_DETECTION.minDurationFractionOfMinClip) {
      windows.push({ start, end, meanScore, frames: cursor.slice() });
    }
    cursor = [];
  };

  let prevT = -Infinity;
  for (const f of sorted) {
    const gap = f.t - prevT;
    if (f.score >= cutoff) {
      if (
        cursor.length > 0 &&
        gap > plan.sampleEverySeconds * EVENT_DETECTION.gapToleranceSamplePeriods
      ) {
        flush();
      }
      cursor.push(f);
      prevT = f.t;
    } else if (cursor.length > 0) {
      flush();
      prevT = f.t;
    } else {
      prevT = f.t;
    }
  }
  flush();

  return {
    windows: windows.map((w) => trimWindowToMax(w, plan.maxClipSeconds)),
    stats,
    cutoff,
    percentile,
    minClipSeconds: minClip
  };
}

function trimWindowToMax(
  w: CandidateWindow,
  maxSeconds: number
): CandidateWindow {
  const duration = w.end - w.start;
  if (duration <= maxSeconds) return w;
  const len = w.frames.length;
  if (len === 0) return w;
  const stepSeconds = (w.end - w.start) / Math.max(len, 1);
  const windowFrames = Math.max(2, Math.round(maxSeconds / stepSeconds));
  let bestStart = 0;
  let bestSum = -Infinity;
  for (let i = 0; i + windowFrames <= len; i++) {
    let sum = 0;
    for (let j = 0; j < windowFrames; j++) sum += w.frames[i + j].score;
    if (sum > bestSum) {
      bestSum = sum;
      bestStart = i;
    }
  }
  const sliced = w.frames.slice(bestStart, bestStart + windowFrames);
  const center = (sliced[0].t + sliced[sliced.length - 1].t) / 2;
  const half = maxSeconds / 2;
  return {
    start: clamp(center - half, w.start, w.end - maxSeconds),
    end: clamp(center + half, w.start + maxSeconds, w.end),
    meanScore: bestSum / sliced.length,
    frames: sliced
  };
}

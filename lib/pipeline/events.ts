import type { CandidateWindow, EditPlan, FrameScore } from "@/lib/types";
import { clamp } from "@/lib/util/time";

/**
 * Detect candidate windows from per-frame scores.
 * Algorithm: walk frames left-to-right; group contiguous frames whose score
 * exceeds a dynamic threshold (mean + 0.5*stddev, floored at 0.15) into windows.
 */
export function detectCandidateWindows(
  frames: FrameScore[],
  plan: EditPlan
): CandidateWindow[] {
  if (frames.length === 0) return [];
  const sorted = [...frames].sort((a, b) => a.t - b.t);
  const scores = sorted.map((f) => f.score);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance =
    scores.reduce((acc, s) => acc + (s - mean) ** 2, 0) / scores.length;
  const stddev = Math.sqrt(variance);
  const threshold = Math.max(0.15, mean + 0.5 * stddev);

  const windows: CandidateWindow[] = [];
  let cursor: FrameScore[] = [];

  const flush = () => {
    if (cursor.length === 0) return;
    const start = cursor[0].t;
    const end = cursor[cursor.length - 1].t + plan.sampleEverySeconds;
    const meanScore =
      cursor.reduce((acc, f) => acc + f.score, 0) / cursor.length;
    const duration = end - start;
    if (duration >= plan.minClipSeconds * 0.6) {
      windows.push({
        start,
        end,
        meanScore,
        frames: cursor.slice()
      });
    }
    cursor = [];
  };

  let prevT = -Infinity;
  for (const f of sorted) {
    const gap = f.t - prevT;
    if (f.score >= threshold) {
      // Tolerate up to 2 sample-period gaps inside a window.
      if (cursor.length > 0 && gap > plan.sampleEverySeconds * 2.5) flush();
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

  // Cap each window to maxClipSeconds, keeping the highest-mean center.
  return windows.map((w) => trimWindowToMax(w, plan.maxClipSeconds));
}

function trimWindowToMax(
  w: CandidateWindow,
  maxSeconds: number
): CandidateWindow {
  const duration = w.end - w.start;
  if (duration <= maxSeconds) return w;
  // Find the highest-density region using a sliding window.
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

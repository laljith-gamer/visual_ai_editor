import type {
  CandidateWindow,
  EditPlan,
  FrameScore,
  Highlight,
  ScoreStats,
  TemporalVerdict,
  UserTier
} from "@/lib/types";
import { detectCandidateWindows } from "@/lib/pipeline/events";
import { runTemporalPass } from "@/lib/pipeline/temporal";
import { newId } from "@/lib/util/id";
import { clamp } from "@/lib/util/time";
import { HIGHLIGHT_SCORING, MOMENT_RETRIEVAL } from "@/lib/config";
import {
  assessConfidence,
  deriveForceMinHighlights
} from "@/lib/pipeline/adapt";

interface BuildArgs {
  videoBlob: Blob;
  frameScores: FrameScore[];
  plan: EditPlan;
  videoDuration: number;
  /** v1.4.0 — same tier the LLM classified for this turn. Drives the
   *  force-min fallback so novice users always get a clip back even if
   *  no window crosses the strong-match bar. */
  userTier?: UserTier;
  /** Source video metadata, used by adapt.ts derivation functions. */
  videoMeta?: { duration: number; width: number; height: number };
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Result of the moment pipeline. Mirrors the shape returned by
 * `buildHighlights`'s BuildResult so the UI can render the same
 * "weak match" copy regardless of which path produced the clip.
 */
export interface MomentBuildResult {
  highlights: Highlight[];
  /** True when the only highlight returned came from the force-min
   *  fallback rather than a confident match — surface "low confidence"
   *  to the user instead of a "couldn't find anything" dead end. */
  weakOnly: boolean;
  /** Number of candidate windows considered overall. */
  consideredCount: number;
  /** Score distribution for diagnostics / chat copy. */
  scoreStats: ScoreStats;
}

/**
 * Moment-retrieval pipeline. Used when the planner returned mode="moment"
 * — the user described one specific scene, and we want exactly ONE clip
 * placed precisely. Two-stage approach (per VideoMind / Mr. BLIP):
 *
 *   1. Localize: find the highest-scoring contiguous run of frames against
 *      the single scenario in plan.scenarios[0].
 *   2. Verify: run a single temporal contact-sheet pass on the top
 *      candidates and refine timestamps with edge padding.
 *
 * v1.4.0: when nothing crosses the strong-match bar AND the user is
 * novice tier, we force-include the single highest-mean-score window
 * with confidence: "low" so the chat surfaces "weak match" instead of
 * an empty dead-end. Advanced users still get an honest empty result.
 */
export async function buildMomentHighlight({
  videoBlob,
  frameScores,
  plan,
  videoDuration,
  userTier,
  videoMeta,
  signal,
  onProgress
}: BuildArgs): Promise<MomentBuildResult> {
  if (frameScores.length === 0) {
    return emptyResult();
  }

  // 1) Detect candidate windows with the adaptive percentile detector.
  const detection = detectCandidateWindows(frameScores, plan, {
    userTier,
    videoMeta: videoMeta ?? { duration: videoDuration, width: 0, height: 0 }
  });
  const candidates = detection.windows;
  const stats = detection.stats;

  if (candidates.length === 0) {
    // No windows even with the adaptive cutoff — try force-min directly
    // off the top frames (if the user is novice).
    return forceMinFromFrames(frameScores, plan, videoDuration, userTier, stats);
  }

  // Keep the top 3 by mean score so the temporal pass cost stays bounded.
  const topCandidates = [...candidates]
    .sort((a, b) => b.meanScore - a.meanScore)
    .slice(0, 3);

  onProgress?.(0, topCandidates.length + 1);

  // 2) Run a tight temporal pass on those few candidates.
  const verdicts = await runTemporalPass({
    videoBlob,
    candidates: topCandidates,
    plan,
    signal,
    onProgress: (done, total) => onProgress?.(done, total + 1)
  });

  // 3) Pick the single best by composite score.
  const best = pickBestVerdict(topCandidates, verdicts, plan);
  onProgress?.(topCandidates.length + 1, topCandidates.length + 1);

  if (!best) {
    return forceMinFromCandidates(
      topCandidates,
      verdicts,
      plan,
      videoDuration,
      userTier,
      stats
    );
  }

  // 4) Refine timestamps with edge padding and clamp to source bounds.
  const refined = refineWindowEdges(best.window, videoDuration);

  return {
    highlights: [
      {
        id: newId("clip"),
        start: round2(refined.start),
        end: round2(refined.end),
        score: round2(best.score),
        reason:
          best.verdict?.reason ?? "Best match for the moment you described",
        label: best.verdict?.label ?? plan.scenarios[0]?.id,
        transition: "none",
        confidence: assessConfidence(best.score)
      }
    ],
    weakOnly: false,
    consideredCount: candidates.length,
    scoreStats: stats
  };
}

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

interface BestPick {
  window: CandidateWindow;
  verdict?: TemporalVerdict;
  score: number;
}

function pickBestVerdict(
  candidates: CandidateWindow[],
  verdicts: TemporalVerdict[],
  plan: EditPlan
): BestPick | null {
  if (candidates.length === 0) return null;
  const verdictMap = new Map<string, TemporalVerdict>();
  for (const v of verdicts) {
    verdictMap.set(`${v.start.toFixed(2)}:${v.end.toFixed(2)}`, v);
  }
  const w = HIGHLIGHT_SCORING.weights;
  let best: BestPick | null = null;
  for (const c of candidates) {
    const v = verdictMap.get(`${c.start.toFixed(2)}:${c.end.toFixed(2)}`);
    const keep = v?.keepScore ?? HIGHLIGHT_SCORING.neutralKeepScore;
    const dur = c.end - c.start;
    const lengthBonus = clamp(dur / Math.max(plan.maxClipSeconds, 1), 0, 1);
    const score =
      w.perFrameMean * c.meanScore +
      w.temporalKeep * keep +
      w.lengthBonus * lengthBonus;
    if (!best || score > best.score) {
      best = { window: c, verdict: v, score };
    }
  }
  return best;
}

/** Force-min using existing scored candidates (pre-temporal-pass form
 *  retained when temporal verdicts are available). */
function forceMinFromCandidates(
  candidates: CandidateWindow[],
  verdicts: TemporalVerdict[],
  plan: EditPlan,
  videoDuration: number,
  userTier: UserTier | undefined,
  stats: ScoreStats
): MomentBuildResult {
  const ctx = {
    plan,
    videoMeta: { duration: videoDuration, width: 0, height: 0 },
    scoreStats: stats,
    userTier
  };
  const minN = deriveForceMinHighlights(ctx);
  if (minN === 0 || candidates.length === 0) {
    return {
      highlights: [],
      weakOnly: false,
      consideredCount: candidates.length,
      scoreStats: stats
    };
  }

  // Pick the highest-mean candidate as the best-effort moment.
  const top = [...candidates].sort((a, b) => b.meanScore - a.meanScore)[0];
  const v = verdicts.find(
    (vd) =>
      Math.abs(vd.start - top.start) < 0.05 &&
      Math.abs(vd.end - top.end) < 0.05
  );
  const w = HIGHLIGHT_SCORING.weights;
  const keep = v?.keepScore ?? HIGHLIGHT_SCORING.neutralKeepScore;
  const dur = top.end - top.start;
  const lengthBonus = clamp(dur / Math.max(plan.maxClipSeconds, 1), 0, 1);
  const score =
    w.perFrameMean * top.meanScore +
    w.temporalKeep * keep +
    w.lengthBonus * lengthBonus;
  const refined = refineWindowEdges(top, videoDuration);

  return {
    highlights: [
      {
        id: newId("clip"),
        start: round2(refined.start),
        end: round2(refined.end),
        score: round2(score),
        reason:
          v?.reason ??
          "Best available match for that moment \u2014 confidence is low",
        label: v?.label ?? plan.scenarios[0]?.id,
        transition: "none",
        confidence: assessConfidence(score)
      }
    ],
    weakOnly: true,
    consideredCount: candidates.length,
    scoreStats: stats
  };
}

/** Force-min when the detector itself returned zero windows. Fall back
 *  to the single highest-scoring frame and pad it into a tiny window. */
function forceMinFromFrames(
  frames: FrameScore[],
  plan: EditPlan,
  videoDuration: number,
  userTier: UserTier | undefined,
  stats: ScoreStats
): MomentBuildResult {
  const ctx = {
    plan,
    videoMeta: { duration: videoDuration, width: 0, height: 0 },
    scoreStats: stats,
    userTier
  };
  const minN = deriveForceMinHighlights(ctx);
  if (minN === 0 || frames.length === 0) {
    return {
      highlights: [],
      weakOnly: false,
      consideredCount: 0,
      scoreStats: stats
    };
  }

  const peak = [...frames].sort((a, b) => b.score - a.score)[0];
  // Synthesise a window centered on the peak frame.
  const half = Math.max(MOMENT_RETRIEVAL.minClipSeconds, 1.5) / 2;
  const candidate: CandidateWindow = {
    start: clamp(peak.t - half, 0, videoDuration),
    end: clamp(peak.t + half, 0, videoDuration),
    meanScore: peak.score,
    frames: [peak]
  };
  const refined = refineWindowEdges(candidate, videoDuration);
  const w = HIGHLIGHT_SCORING.weights;
  const dur = refined.end - refined.start;
  const lengthBonus = clamp(dur / Math.max(plan.maxClipSeconds, 1), 0, 1);
  const score =
    w.perFrameMean * peak.score +
    w.temporalKeep * HIGHLIGHT_SCORING.neutralKeepScore +
    w.lengthBonus * lengthBonus;

  return {
    highlights: [
      {
        id: newId("clip"),
        start: round2(refined.start),
        end: round2(refined.end),
        score: round2(score),
        reason:
          "Best available match for that moment \u2014 confidence is low",
        label: plan.scenarios[0]?.id,
        transition: "none",
        confidence: assessConfidence(score)
      }
    ],
    weakOnly: true,
    consideredCount: 0,
    scoreStats: stats
  };
}

function refineWindowEdges(
  w: CandidateWindow,
  videoDuration: number
): { start: number; end: number } {
  const pad = MOMENT_RETRIEVAL.edgePaddingSeconds;
  let start = Math.max(0, w.start - pad);
  let end = Math.min(videoDuration, w.end + pad);
  // Cap to MOMENT_RETRIEVAL.maxClipSeconds, keeping center.
  const dur = end - start;
  if (dur > MOMENT_RETRIEVAL.maxClipSeconds) {
    const center = (start + end) / 2;
    const half = MOMENT_RETRIEVAL.maxClipSeconds / 2;
    start = clamp(center - half, 0, videoDuration);
    end = clamp(center + half, 0, videoDuration);
  }
  // Floor minimum duration.
  if (end - start < MOMENT_RETRIEVAL.minClipSeconds) {
    const center = (start + end) / 2;
    const half = MOMENT_RETRIEVAL.minClipSeconds / 2;
    start = clamp(center - half, 0, videoDuration);
    end = clamp(center + half, 0, videoDuration);
  }
  return { start, end };
}

function emptyResult(): MomentBuildResult {
  return {
    highlights: [],
    weakOnly: false,
    consideredCount: 0,
    scoreStats: { count: 0, max: 0, mean: 0, p50: 0, p75: 0, p90: 0 }
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

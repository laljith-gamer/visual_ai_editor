import type {
  CandidateWindow,
  EditPlan,
  FrameScore,
  Highlight,
  TemporalVerdict
} from "@/lib/types";
import { detectCandidateWindows } from "@/lib/pipeline/events";
import { runTemporalPass } from "@/lib/pipeline/temporal";
import { newId } from "@/lib/util/id";
import { clamp } from "@/lib/util/time";
import { HIGHLIGHT_SCORING, MOMENT_RETRIEVAL } from "@/lib/config";

interface BuildArgs {
  videoBlob: Blob;
  frameScores: FrameScore[];
  plan: EditPlan;
  videoDuration: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Moment-retrieval pipeline. Used when the planner returned mode="moment"
 * — the user described one specific scene, and we want exactly ONE clip
 * placed precisely. Two-stage approach (per VideoMind / Mr. BLIP):
 *
 *   1. Localize: find the highest-scoring contiguous run of frames against
 *      the single scenario in plan.scenarios[0].
 *   2. Verify: run a single temporal contact-sheet pass on that window
 *      and refine timestamps with edge padding.
 *
 * Returns 0 or 1 highlights. Cheaper than the multi-clip pipeline because
 * we only invoke the cloud temporal pass once, not 6–8 times.
 */
export async function buildMomentHighlight({
  videoBlob,
  frameScores,
  plan,
  videoDuration,
  signal,
  onProgress
}: BuildArgs): Promise<Highlight[]> {
  if (frameScores.length === 0) return [];

  // 1) Detect candidate windows with the standard threshold logic.
  //    Even though we want one clip, using the same detector ensures we
  //    don't miss a real peak surrounded by noise.
  //    v1.3.0: detectCandidateWindows now returns DetectionResult; we
  //    only need the windows array here.
  const candidates = detectCandidateWindows(frameScores, plan).windows;
  if (candidates.length === 0) return [];

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
  if (!best) return [];

  // 4) Refine timestamps with edge padding and clamp to source bounds.
  const refined = refineWindowEdges(best.window, videoDuration);

  onProgress?.(topCandidates.length + 1, topCandidates.length + 1);

  return [
    {
      id: newId("clip"),
      start: round2(refined.start),
      end: round2(refined.end),
      score: round2(best.score),
      reason: best.verdict?.reason ?? "Best match for the moment you described",
      label: best.verdict?.label ?? plan.scenarios[0]?.id,
      transition: "none"
    }
  ];
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

import type {
  CandidateWindow,
  EditPlan,
  Highlight,
  ScoreStats,
  TemporalVerdict,
  UserTier
} from "@/lib/types";
import { newId } from "@/lib/util/id";
import { clamp } from "@/lib/util/time";
import { HIGHLIGHT_SCORING } from "@/lib/config";
import {
  assessConfidence,
  deriveForceMinHighlights
} from "@/lib/pipeline/adapt";

interface BuildArgs {
  candidates: CandidateWindow[];
  verdicts: TemporalVerdict[];
  plan: EditPlan;
  videoDuration: number;
  userTier?: UserTier;
  scoreStats?: ScoreStats;
}

export interface BuildResult {
  highlights: Highlight[];
  weakOnly: boolean;
  consideredCount: number;
}

/**
 * v1.3.0: Build highlights with adaptive force-min for novice tier.
 * If selection returns 0 but we have at least one scored candidate AND
 * the user is novice, we force-include the top candidate(s) with
 * confidence: "low" so the chat surfaces "weak match".
 */
export function buildHighlights(args: BuildArgs): BuildResult {
  if (args.candidates.length === 0) {
    return { highlights: [], weakOnly: false, consideredCount: 0 };
  }

  const verdictMap = new Map<string, TemporalVerdict>();
  for (const v of args.verdicts) {
    verdictMap.set(`${v.start.toFixed(2)}:${v.end.toFixed(2)}`, v);
  }

  const w = HIGHLIGHT_SCORING.weights;
  const scored = args.candidates
    .map((c) => {
      const v = verdictMap.get(`${c.start.toFixed(2)}:${c.end.toFixed(2)}`);
      const keep = v?.keepScore ?? HIGHLIGHT_SCORING.neutralKeepScore;
      const dur = c.end - c.start;
      const lengthBonus = clamp(dur / Math.max(args.plan.maxClipSeconds, 1), 0, 1);
      const score =
        w.perFrameMean * c.meanScore +
        w.temporalKeep * keep +
        w.lengthBonus * lengthBonus;
      return { candidate: c, verdict: v, score, duration: dur };
    })
    .filter((s) => s.duration >= args.plan.minClipSeconds);

  const consideredCount = scored.length;
  if (scored.length === 0) {
    return forceMinFallback(args, []);
  }

  const targetSeconds = args.plan.targetShortSeconds;
  const selected: typeof scored = [];

  if (args.plan.selectionStrategy === "best") {
    const ranked = [...scored].sort((a, b) => b.score - a.score);
    let total = 0;
    for (const s of ranked) {
      if (overlapsAny(s.candidate, selected.map((x) => x.candidate))) continue;
      selected.push(s);
      total += s.duration;
      if (total >= targetSeconds) break;
    }
  } else {
    const desiredCount = Math.max(
      HIGHLIGHT_SCORING.minDesiredClipCount,
      Math.ceil(
        targetSeconds /
          Math.max(args.plan.maxClipSeconds * 0.6, HIGHLIGHT_SCORING.minBucketSeconds)
      )
    );
    const bucketSeconds = Math.max(
      args.videoDuration / desiredCount,
      HIGHLIGHT_SCORING.minBucketSeconds
    );
    const buckets = new Map<number, typeof scored>();
    for (const s of scored) {
      const b = Math.floor(s.candidate.start / bucketSeconds);
      const list = buckets.get(b) ?? [];
      list.push(s);
      buckets.set(b, list);
    }
    const sortedBuckets = [...buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, list]) => list.sort((a, b) => b.score - a.score));

    let total = 0;
    let round = 0;
    while (total < targetSeconds && round < HIGHLIGHT_SCORING.maxSelectionRounds) {
      let progressed = false;
      for (const list of sortedBuckets) {
        const pick = list.shift();
        if (!pick) continue;
        if (overlapsAny(pick.candidate, selected.map((x) => x.candidate))) continue;
        selected.push(pick);
        total += pick.duration;
        progressed = true;
        if (total >= targetSeconds) break;
      }
      if (!progressed) break;
      round++;
    }
  }

  selected.sort((a, b) => a.candidate.start - b.candidate.start);

  if (selected.length === 0) {
    return forceMinFallback(args, scored);
  }

  return {
    highlights: selected.map((s, i): Highlight => ({
      id: newId("clip"),
      start: round2(s.candidate.start),
      end: round2(s.candidate.end),
      score: round2(s.score),
      reason: s.verdict?.reason ?? "Strong visual match",
      label: s.verdict?.label,
      transition: i === 0 ? "none" : args.plan.transition,
      confidence: assessConfidence(s.score)
    })),
    weakOnly: false,
    consideredCount
  };
}

function forceMinFallback(
  args: BuildArgs,
  scored: Array<{
    candidate: CandidateWindow;
    verdict: TemporalVerdict | undefined;
    score: number;
    duration: number;
  }>
): BuildResult {
  const ctx = {
    plan: args.plan,
    videoMeta: { duration: args.videoDuration, width: 0, height: 0 },
    scoreStats: args.scoreStats,
    userTier: args.userTier
  };
  const minN = deriveForceMinHighlights(ctx);
  if (minN === 0) {
    return { highlights: [], weakOnly: false, consideredCount: scored.length };
  }
  // If filter dropped everything, score the candidates without minClip filter
  const pool =
    scored.length > 0
      ? scored
      : args.candidates.map((c) => {
          const v = args.verdicts.find(
            (vd) =>
              Math.abs(vd.start - c.start) < 0.05 &&
              Math.abs(vd.end - c.end) < 0.05
          );
          const keep = v?.keepScore ?? HIGHLIGHT_SCORING.neutralKeepScore;
          const dur = c.end - c.start;
          const lengthBonus = clamp(dur / Math.max(args.plan.maxClipSeconds, 1), 0, 1);
          const W = HIGHLIGHT_SCORING.weights;
          const score =
            W.perFrameMean * c.meanScore +
            W.temporalKeep * keep +
            W.lengthBonus * lengthBonus;
          return { candidate: c, verdict: v, score, duration: dur };
        });
  if (pool.length === 0) {
    return { highlights: [], weakOnly: false, consideredCount: 0 };
  }
  const top = [...pool].sort((a, b) => b.score - a.score).slice(0, minN);
  top.sort((a, b) => a.candidate.start - b.candidate.start);
  return {
    highlights: top.map((s, i): Highlight => ({
      id: newId("clip"),
      start: round2(s.candidate.start),
      end: round2(s.candidate.end),
      score: round2(s.score),
      reason:
        s.verdict?.reason ??
        "Best available match (low confidence \u2014 try broader scenarios)",
      label: s.verdict?.label,
      transition: i === 0 ? "none" : args.plan.transition,
      confidence: assessConfidence(s.score)
    })),
    weakOnly: true,
    consideredCount: pool.length
  };
}

function overlapsAny(a: CandidateWindow, others: CandidateWindow[]): boolean {
  for (const o of others) {
    if (a.start < o.end && a.end > o.start) return true;
  }
  return false;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

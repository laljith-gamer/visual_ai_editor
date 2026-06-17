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
import { HIGHLIGHT_SCORING, PLAN_DEFAULTS } from "@/lib/config";
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

  // v1.7.1 — Quality-floor selection path.
  //
  // v1.7.2 — Progressive-floor fallback. Real-world SigLIP scores on
  // user footage commonly land in the 0.45-0.65 band; the prior
  // implementation's hard 0.55 cutoff was rejecting genuine matches
  // and dropping runs to a single weak clip via forceMinFallback.
  // We now try three tiers in order:
  //   1. base floor          → preferred matches
  //   2. base floor - 0.10   → soft matches (weakOnly = true)
  //   3. top-N regardless    → borderline matches (weakOnly = true,
  //                            N = ceil(scoredCount / 4), min 2)
  // Each tier's candidates still flow through overlap + duration caps.
  // There is deliberately NO output clip-count cap for no-duration
  // "best parts" requests; the total-duration guard is the only limiter.
  if (!args.plan.userSpecifiedDuration) {
    const baseFloor = args.plan.qualityFloor ?? PLAN_DEFAULTS.qualityFloor;

    let pool = scored.filter((s) => s.score >= baseFloor);
    let weakOnly = false;
    if (pool.length === 0) {
      pool = scored.filter((s) => s.score >= baseFloor - 0.1);
      weakOnly = true;
    }
    if (pool.length === 0) {
      const fallbackN = Math.max(2, Math.ceil(scored.length / 4));
      pool = [...scored].sort((a, b) => b.score - a.score).slice(0, fallbackN);
      weakOnly = true;
    }

    const ranked = [...pool].sort((a, b) => b.score - a.score);
    const selectedQ: typeof scored = [];
    let totalQ = 0;
    for (const s of ranked) {
      if (totalQ + s.duration > PLAN_DEFAULTS.maxTotalSecondsWithoutBudget) continue;
      if (overlapsAny(s.candidate, selectedQ.map((x) => x.candidate))) continue;
      selectedQ.push(s);
      totalQ += s.duration;
    }
    selectedQ.sort((a, b) => a.candidate.start - b.candidate.start);

    if (selectedQ.length === 0) {
      return forceMinFallback(args, scored);
    }

    return {
      highlights: selectedQ.map((s, i): Highlight => ({
        id: newId("clip"),
        start: round2(s.candidate.start),
        end: round2(s.candidate.end),
        score: round2(s.score),
        reason: weakOnly
          ? `Best available match (top score ${round2(s.score)}) — try a more specific prompt or use the briefing`
          : s.verdict?.reason ?? "Strong visual match",
        label: s.verdict?.label,
        transition: i === 0 ? "none" : args.plan.transition,
        confidence: assessConfidence(s.score)
      })),
      weakOnly,
      consideredCount
    };
  }

  // ---------- Budgeted path (existing behaviour) ----------
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
        "Best available match (low confidence — try broader scenarios)",
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

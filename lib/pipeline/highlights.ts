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
import { HIGHLIGHT_SCORING, PLAN_DEFAULTS, TARGET_COVERAGE, OFFLINE_BEST_PARTS } from "@/lib/config";
import {
  assessConfidence,
  deriveForceMinHighlights
} from "@/lib/pipeline/adapt";
import { buildOfflineBestParts } from "@/lib/pipeline/bestParts";
import { deriveClipDurationBounds } from "@/lib/pipeline/clipDuration";
import { pickFillIndices } from "@/lib/pipeline/selectionFill";

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
    // Every candidate window was shorter than minClipSeconds (e.g. 1s motion
    // peaks at 1s sampling). Build a properly paced, SPREAD reel from the raw
    // candidates (expanding short peaks) instead of collapsing to a single 1s
    // clip. This now applies to NO-DURATION "best parts" too — gating it
    // behind userSpecifiedDuration was the cause of the reported 1×1s result.
    const fb = tryOfflineBestParts(args, consideredCount, 0);
    if (fb) return fb;
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
    // "Best parts" (visual-interest: SigLIP intentionally skipped / no
    // scenarios) → build a paced, SPREAD multi-clip reel toward the soft
    // target rather than a sparse quality-floor pick that can collapse to a
    // single clip. This is the Eddie-style behaviour: several sensibly-paced
    // clips spread across the video, with clip lengths scaled by interest.
    if (isVisualInterestPlan(args.plan)) {
      const fb = tryOfflineBestParts(args, consideredCount, 0);
      if (fb) return fb;
    }

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

    const selectedSecondsQ = selectedQ.reduce((acc, s) => acc + s.duration, 0);
    // Collapse guard: if the floor selection produced nothing or only a single
    // sub-useful sliver, spread a real reel from the candidates instead of
    // shipping a 1s clip.
    if (
      selectedQ.length === 0 ||
      selectedSecondsQ < TARGET_COVERAGE.minUsefulClipSeconds
    ) {
      const fb = tryOfflineBestParts(args, consideredCount, selectedSecondsQ);
      if (fb) return fb;
    }

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

  // Top-up to the target. The `balanced` strategy fills bucket-by-bucket with
  // a capped number of rounds and drops overlapping picks, so it can stall at
  // ~half the requested length (the reported "1 min → 30s"). When the user
  // stated a duration and we're still short, greedily pull the best remaining
  // non-overlapping clips until we reach the target — so the reel actually
  // fills toward the requested length when the footage allows.
  if (args.plan.userSpecifiedDuration && targetSeconds > 0) {
    const totalNow = selected.reduce((acc, s) => acc + s.duration, 0);
    if (totalNow < targetSeconds) {
      const inSelection = new Set(selected);
      const pool = scored.filter((s) => !inSelection.has(s));
      const add = pickFillIndices(
        pool.map((s) => ({
          start: s.candidate.start,
          end: s.candidate.end,
          score: s.score
        })),
        selected.map((s) => ({ start: s.candidate.start, end: s.candidate.end })),
        totalNow,
        targetSeconds
      );
      for (const idx of add) selected.push(pool[idx]);
      selected.sort((a, b) => a.candidate.start - b.candidate.start);
    }
  }

  // Issue #62 — offline best-parts underfill guard. When the user stated a
  // duration but the strong-match selection is materially short of it (or
  // empty), broaden using the CPU/offline fallback: expand short windows and
  // spread picks across the source to approach the target. This is what stops
  // a 40s request collapsing to a single 1s peak when the visual verdict is
  // unavailable (cloud disabled / WebGPU absent). We only REPLACE the
  // selection when the fallback genuinely covers more.
  if (args.plan.userSpecifiedDuration) {
    const target = args.plan.targetShortSeconds;
    const selectedSeconds = selected.reduce((acc, s) => acc + s.duration, 0);
    const minReady = target * TARGET_COVERAGE.minReadyFraction;
    if (target > 0 && (selected.length === 0 || selectedSeconds < minReady)) {
      const fb = tryOfflineBestParts(args, consideredCount, selectedSeconds);
      if (fb) return fb;
    }
  }

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

function tryOfflineBestParts(
  args: BuildArgs,
  consideredCount: number,
  currentSelectedSeconds: number
): BuildResult | null {
  const target = args.plan.targetShortSeconds;
  if (!(target > 0)) return null;
  // v2.5 — DYNAMIC clip bounds derived from the source length + target,
  // replacing the flat ~3s floor (max(minUsefulClipSeconds, plan.minClipSeconds)).
  // Min can be ~1s on short videos; max scales with the video; per-clip length
  // varies with interest score inside buildOfflineBestParts.
  const bounds = deriveClipDurationBounds({
    videoDuration: args.videoDuration,
    targetSeconds: target
  });
  const fb = buildOfflineBestParts({
    candidates: args.candidates.map((c) => ({
      start: c.start,
      end: c.end,
      score: c.meanScore
    })),
    sourceDuration: args.videoDuration,
    targetSeconds: target,
    minUsefulSeconds: bounds.minClipSeconds,
    maxClipSeconds: bounds.maxClipSeconds,
    preferredSeconds: bounds.preferredClipSeconds,
    maxClips: OFFLINE_BEST_PARTS.maxClips
  });
  const fbSeconds = fb.reduce((acc, h) => acc + (h.end - h.start), 0);
  if (fb.length === 0 || fbSeconds <= currentSelectedSeconds) return null;
  // For a genuine "best parts" (visual-interest) request the spread reel IS the
  // intended result — not a weak fallback — so it must not be flagged
  // low-confidence (that's what made a 0.99-score reel read as "low").
  const visualInterest = isVisualInterestPlan(args.plan);
  return {
    highlights: fb.map((h, i): Highlight => ({
      id: newId("clip"),
      start: round2(h.start),
      end: round2(h.end),
      score: round2(h.score),
      reason: visualInterest
        ? "Picked for visual interest \u2014 motion, framing, and scene changes"
        : "Visual AI couldn\u2019t load here, so these are the most active moments by motion. Turn on Fast (cloud) analysis or open in a WebGPU browser for true scene matching.",
      transition: i === 0 ? "none" : args.plan.transition,
      confidence: assessConfidence(h.score)
    })),
    weakOnly: !visualInterest,
    consideredCount
  };
}

/**
 * A "best parts" / visual-interest plan: SigLIP is intentionally skipped
 * (semantic weight 0) or there are no scenarios to match. The motion/saliency
 * spread is the INTENDED selection for these, so its output should never be
 * surfaced as a low-confidence "weak match".
 */
function isVisualInterestPlan(plan: EditPlan): boolean {
  if (plan.scenarios.length === 0) return true;
  if (plan.signals && plan.signals.semantic === 0) return true;
  return false;
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

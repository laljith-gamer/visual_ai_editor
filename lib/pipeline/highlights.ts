import type {
  CandidateWindow,
  EditPlan,
  Highlight,
  TemporalVerdict
} from "@/lib/types";
import { newId } from "@/lib/util/id";
import { clamp } from "@/lib/util/time";
import { HIGHLIGHT_SCORING } from "@/lib/config";

interface BuildArgs {
  candidates: CandidateWindow[];
  verdicts: TemporalVerdict[];
  plan: EditPlan;
  videoDuration: number;
}

/**
 * Combine candidate windows with their temporal verdicts and pick the final
 * highlight set. All weights and selection knobs live in lib/config.ts →
 * HIGHLIGHT_SCORING. Pipeline behaviour is therefore tunable without code
 * changes.
 */
export function buildHighlights({
  candidates,
  verdicts,
  plan,
  videoDuration
}: BuildArgs): Highlight[] {
  if (candidates.length === 0) return [];

  const verdictMap = new Map<string, TemporalVerdict>();
  for (const v of verdicts) {
    verdictMap.set(`${v.start.toFixed(2)}:${v.end.toFixed(2)}`, v);
  }

  const w = HIGHLIGHT_SCORING.weights;
  const scored = candidates
    .map((c) => {
      const v = verdictMap.get(`${c.start.toFixed(2)}:${c.end.toFixed(2)}`);
      const keep = v?.keepScore ?? HIGHLIGHT_SCORING.neutralKeepScore;
      const dur = c.end - c.start;
      const lengthBonus = clamp(dur / Math.max(plan.maxClipSeconds, 1), 0, 1);
      const score =
        w.perFrameMean * c.meanScore +
        w.temporalKeep * keep +
        w.lengthBonus * lengthBonus;
      return { candidate: c, verdict: v, score, duration: dur };
    })
    .filter((s) => s.duration >= plan.minClipSeconds);

  if (scored.length === 0) return [];

  const targetSeconds = plan.targetShortSeconds;
  const selected: typeof scored = [];

  if (plan.selectionStrategy === "best") {
    const ranked = [...scored].sort((a, b) => b.score - a.score);
    let total = 0;
    for (const s of ranked) {
      if (overlapsAny(s.candidate, selected.map((x) => x.candidate))) continue;
      selected.push(s);
      total += s.duration;
      if (total >= targetSeconds) break;
    }
  } else {
    // Balanced: bucket by timeline position so we don't pick everything from
    // one stretch of the video.
    const desiredCount = Math.max(
      HIGHLIGHT_SCORING.minDesiredClipCount,
      Math.ceil(
        targetSeconds /
          Math.max(plan.maxClipSeconds * 0.6, HIGHLIGHT_SCORING.minBucketSeconds)
      )
    );
    const bucketSeconds = Math.max(
      videoDuration / desiredCount,
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

  return selected.map((s, i): Highlight => ({
    id: newId("clip"),
    start: round2(s.candidate.start),
    end: round2(s.candidate.end),
    score: round2(s.score),
    reason: s.verdict?.reason ?? "Strong visual match",
    label: s.verdict?.label,
    transition: i === 0 ? "none" : plan.transition
  }));
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

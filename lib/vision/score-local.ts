import type { EditPlan, FrameScore } from "@/lib/types";

/** Apply labelWeights to per-frame raw label probabilities → aggregate score. */
export function aggregateFrameScore(
  perLabel: Record<string, number>,
  plan: EditPlan
): number {
  let total = 0;
  for (const s of plan.scenarios) {
    const w = plan.labelWeights[s.id] ?? 0;
    const v = perLabel[s.id] ?? 0;
    total += w * v;
  }
  return Math.max(0, Math.min(1, total));
}

/** Convert raw worker output into FrameScore[]. */
export function toFrameScores(
  results: Array<{ t: number; labels: Record<string, number> }>,
  plan: EditPlan
): FrameScore[] {
  return results.map((r) => ({
    t: r.t,
    labels: r.labels,
    score: aggregateFrameScore(r.labels, plan)
  }));
}

/**
 * v1.7.7 — Multi-clause trim/range → per-source merge.
 *
 * Triggers (clauses are detected by lib/intent/clauses.ts):
 *   "trim first 10 in first video 5 in second video"
 *   "trim last 10 in video 1 and last 5 in video 2"
 *   "first 30 from first video, last 30 from second video"
 *
 * For each clause we resolve a (sourceId, startSeconds, endSeconds)
 * tuple. The leading clause's verb determines whether the range is
 * inclusive ("first 30 from V1" = take 0..30) or inverted ("trim
 * first 10 from V1" = take 10..end). The dispatcher (`runMerge` in
 * lib/intent/dispatch.ts) reads `sourceRanges` and lays one highlight
 * per entry.
 *
 * This pattern intentionally fires ONLY for 2+ clauses. The single-
 * clause case stays with `extract` (existing behaviour) — we don't
 * want to retro-change extract semantics.
 */

import { hasNegation, type ParsedText } from "../grammar";
import { splitIntoClauses } from "../clauses";
import { resolveSourceReference } from "../slots";
import { parseRange } from "../time";
import { TRIM_VERBS } from "../dictionary";
import type { QuickMatchContext, QuickMatchMerge } from "../types";

export function matchTrimMerge(
  p: ParsedText,
  ctx: QuickMatchContext
): QuickMatchMerge | null {
  if (hasNegation(p)) return null;
  if (ctx.sources.length === 0) return null;

  const clauses = splitIntoClauses(p.raw);
  if (clauses.length < 2) return null;

  // The verb context comes from clause 0. We check the FULL leading
  // text (everything up to the first per-source group) not just the
  // single first clause string — handles the "trim first N in V1
  // [implicit] M in V2" structure where clauses[0] already contains
  // both verb and first-clause range.
  const leadingLower = clauses[0].toLowerCase();
  const isTrimContext = TRIM_VERBS.some((v) =>
    new RegExp(`\\b${v}\\b`).test(leadingLower)
  );

  const sourceRanges: NonNullable<QuickMatchMerge["sourceRanges"]> = [];
  const usedSourceIds = new Set<string>();

  for (const clauseRaw of clauses) {
    const lower = clauseRaw.toLowerCase();

    // Each clause must reference a source. We pick the FIRST source
    // resolved per clause (the splitter pairs each clause with one
    // "in <Nth> video" group, so multi-source-per-clause is
    // unexpected).
    const sourceRef = resolveSourceReference(lower, ctx);
    if (sourceRef.sourceIds.length === 0) continue;
    const sourceId = sourceRef.sourceIds[0];
    if (usedSourceIds.has(sourceId)) continue;
    const source = ctx.sources.find((s) => s.id === sourceId);
    if (!source) continue;

    // Each clause must produce a parseable time range.
    const range = parseRange(lower);
    if (!range) continue;

    const dur = source.meta.duration;
    if (!Number.isFinite(dur) || dur <= 0) continue;

    let startSeconds: number;
    let endSeconds: number;

    // Range semantics — driven by the leading verb.
    //
    //   "first N"  +  trim verb  →  keep [N, dur]    (the user wants the rest)
    //   "first N"  no trim verb  →  keep [0, N]      (vanilla extract)
    //   "last N"   +  trim verb  →  keep [0, dur-N]
    //   "last N"   no trim verb  →  keep [dur-N, dur]
    //   "M:SS to M:SS"           →  keep [M:SS, M:SS] regardless of verb
    if (isTrimContext && range.kind === "first") {
      startSeconds = Math.min(dur, range.endSeconds);
      endSeconds = dur;
    } else if (isTrimContext && range.kind === "last") {
      startSeconds = 0;
      endSeconds = Math.max(0, dur - range.endSeconds);
    } else if (range.kind === "first") {
      startSeconds = 0;
      endSeconds = Math.min(dur, range.endSeconds);
    } else if (range.kind === "last") {
      startSeconds = Math.max(0, dur - range.endSeconds);
      endSeconds = dur;
    } else {
      // Absolute range. Clamp both endpoints into source duration.
      startSeconds = Math.max(0, Math.min(dur, range.startSeconds));
      endSeconds = Math.max(0, Math.min(dur, range.endSeconds));
    }

    // Reject zero / negative-length ranges (e.g. "trim first 30" on a
    // 25s video). Caller falls through to cloud planner.
    if (endSeconds <= startSeconds + 0.1) continue;

    sourceRanges.push({ sourceId, startSeconds, endSeconds });
    usedSourceIds.add(sourceId);
  }

  // Need at least 2 successfully-resolved per-source clauses for this
  // pattern to fire. One = falls through to single-clause extract.
  if (sourceRanges.length < 2) return null;

  return {
    kind: "merge",
    confidence: 0.92,
    patternId: isTrimContext ? "merge.trim_per_source" : "merge.range_per_source",
    matchedText: p.raw,
    sourceIds: sourceRanges.map((r) => r.sourceId),
    transition: "none",
    op: "replace",
    sourceRanges
  };
}

/**
 * v1.7.5 — Extract intent matcher.
 *
 * Triggers: "first 30 seconds", "last 10s", "from 0:30 to 1:45",
 * "give me the first minute".
 *
 * Boundary rule:
 *   - Bare time slices replace the timeline through extract mode.
 *   - Explicit additive time slices append through merge mode.
 *     Example: "add last 30s", "also include first 10s".
 */

import { EXTRACT_VERBS } from "../dictionary";
import { hasNegation, hasVerbLemma, type ParsedText } from "../grammar";
import { resolveSourceReference } from "../slots";
import { parseRange } from "../time";
import type {
  QuickMatchContext,
  QuickMatchExtract,
  QuickMatchMerge
} from "../types";

const APPEND_RANGE_RE = /\b(?:add|also|append|include)\b/;

export function matchExtract(
  p: ParsedText,
  ctx: QuickMatchContext
): QuickMatchExtract | QuickMatchMerge | null {
  if (hasNegation(p)) return null;
  if (ctx.sources.length === 0) return null;

  const range = parseRange(p.lower);
  if (!range) return null;

  const sourceRef = resolveSourceReference(p.lower, ctx);
  const sourceId =
    sourceRef.sourceIds.length === 1 ? sourceRef.sourceIds[0] : undefined;

  if (APPEND_RANGE_RE.test(p.lower)) {
    const appendSourceId =
      sourceId ??
      (ctx.selectedSourceIds.length === 1
        ? ctx.selectedSourceIds[0]
        : ctx.sources[0]?.id);
    const source = ctx.sources.find((s) => s.id === appendSourceId);
    if (!source) return null;

    const dur = source.meta.duration;
    if (!Number.isFinite(dur) || dur <= 0) return null;

    let startSeconds: number;
    let endSeconds: number;
    if (range.kind === "first") {
      startSeconds = 0;
      endSeconds = Math.min(dur, range.endSeconds);
    } else if (range.kind === "last") {
      const length = Math.max(0, range.endSeconds - range.startSeconds);
      endSeconds = dur;
      startSeconds = Math.max(0, dur - length);
    } else {
      startSeconds = Math.max(0, Math.min(dur, range.startSeconds));
      endSeconds = Math.max(0, Math.min(dur, range.endSeconds));
    }

    if (endSeconds <= startSeconds + 0.1) return null;

    return {
      kind: "merge",
      confidence: 0.93,
      patternId: "merge.append_time_slice",
      matchedText: p.raw,
      sourceIds: [source.id],
      transition: "none",
      op: "append",
      sourceRanges: [{ sourceId: source.id, startSeconds, endSeconds }]
    };
  }

  let confidence = 0.85; // clean range parse is the strong signal

  if (hasVerbLemma(p, EXTRACT_VERBS)) confidence += 0.08;
  if (sourceId) confidence += 0.05;

  return {
    kind: "extract",
    confidence: Math.min(1, confidence),
    patternId: `extract.${range.kind}.replace`,
    matchedText: p.raw,
    range: {
      kind: range.kind,
      startSeconds: range.startSeconds,
      endSeconds: range.endSeconds,
      spoken: range.spoken
    },
    sourceId
  };
}

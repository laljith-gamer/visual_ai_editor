/**
 * v1.7.5 — Edit intent matcher (mechanical clip mutations).
 *
 * Six sub-patterns, each producing one EditOperation:
 *   - trim_first    "trim first 30s"
 *   - trim_last     "trim last 10s"
 *   - drop_range    "drop 0:30 to 0:45"
 *   - keep_range    "keep only 0:30 to 1:00"
 *   - split_at      "split at 1:00"
 *   - split_selected "split this clip"
 *   - reset_source  "reset video 1"
 *
 * All require existing timeline clips (an empty timeline routes to
 * extract / plan / merge instead). All require the matching verb +
 * a clear numeric or pronoun anchor — "trim" alone with no number
 * doesn't fire.
 *
 * Confidence model:
 *   - 0.90 when verb + clean range/duration are both present
 *   - 0.85 when verb + pronoun ("this clip") with state.selectedClipId set
 *   - 0.85 for "reset <source ref>" with a resolvable source
 *   - threshold 0.85 at the orchestrator
 */

import {
  DROP_VERBS,
  KEEP_VERBS,
  RESET_VERBS,
  SPLIT_VERBS,
  TRIM_VERBS
} from "../dictionary";
import { hasNegation, hasVerbLemma, parse, type ParsedText } from "../grammar";
import { splitIntoClauses } from "../clauses";
import {
  resolveClipReference,
  resolveSourceReference
} from "../slots";
import { parseDuration, parseRange, parseTimestamp } from "../time";
import type {
  EditOperation
} from "@/lib/types";
import type { QuickMatchContext, QuickMatchEdit } from "../types";

export function matchEdit(
  p: ParsedText,
  ctx: QuickMatchContext
): QuickMatchEdit | null {
  if (hasNegation(p)) return null;
  if (ctx.highlights.length === 0) return null;

  // v1.7.7 — Multi-clause path. Compound utterances like
  // "trim first 10 from V1 and 5 from V2" each carry their own
  // (verb, duration, source-ref) and we want one EditOperation per
  // clause stamped with the right sourceId. Falls back to single-
  // clause when the splitter doesn't find a boundary.
  const clauses = splitIntoClauses(p.raw);
  if (clauses.length >= 2) {
    const ops: EditOperation[] = [];
    for (const clauseRaw of clauses) {
      const subP = parse(clauseRaw);
      const single = matchSingleEdit(subP, ctx);
      if (single) ops.push(single.op);
    }
    if (ops.length >= 2) {
      return {
        kind: "edit",
        confidence: 0.9,
        patternId: "edit.sequence",
        matchedText: p.raw,
        operations: ops
      };
    }
    if (ops.length === 1) {
      // Only one clause produced an op — degrade gracefully to a
      // single-op response. Better than dropping the whole turn.
      return {
        kind: "edit",
        confidence: 0.88,
        patternId: "edit.sequence_partial",
        matchedText: p.raw,
        operations: ops
      };
    }
    // No clauses matched — fall through to the single-clause matcher
    // below. The whole-utterance read might still produce a hit
    // (verb stretches a long way past clause boundaries).
  }

  // ---- Single-clause path -------------------------------------------
  const single = matchSingleEdit(p, ctx);
  if (!single) return null;
  return {
    kind: "edit",
    confidence: single.confidence,
    patternId: single.pattern,
    matchedText: p.raw,
    operations: [single.op]
  };
}

/** Single-clause sub-matcher. Returns the first valid op found. When
 *  multiple op kinds match in one clause, we return null — composite
 *  edits in a single clause are too risky and route to cloud.
 *
 *  Pulled out so the multi-clause path above can call it per-clause. */
function matchSingleEdit(
  p: ParsedText,
  ctx: QuickMatchContext
): { op: EditOperation; pattern: string; confidence: number } | null {
  if (ctx.highlights.length === 0) return null;

  // Candidates collected across sub-patterns. Each carries an op plus
  // confidence + a pattern id for the activity log.
  const candidates: Array<{
    op: EditOperation;
    pattern: string;
    confidence: number;
  }> = [];

  // v1.7.7 — Single-clause source reference. When the user says
  // "trim first 10s in first video", we want the resulting op stamped
  // with sourceId so the dispatcher applies it to the right source
  // instead of the active one. Resolved once here and threaded into
  // each sub-pattern below.
  const sourceRef = resolveSourceReference(p.lower, ctx);
  const clauseSourceId =
    sourceRef.sourceIds.length === 1 ? sourceRef.sourceIds[0] : undefined;

  // ---- trim_first / trim_last ---------------------------------------
  if (hasVerbLemma(p, TRIM_VERBS)) {
    const firstMatch = p.lower.match(
      /(?:trim|cut|remove|shorten|shave|delete)\s+(?:the\s+)?(?:first|opening|intro)\s+(.+)/
    );
    if (firstMatch) {
      const seconds = parseDuration(firstMatch[1]);
      if (seconds != null && seconds > 0) {
        candidates.push({
          op: { kind: "trim_first", seconds, sourceId: clauseSourceId },
          pattern: "edit.trim_first",
          confidence: 0.92
        });
      }
    }
    const lastMatch = p.lower.match(
      /(?:trim|cut|remove|shorten|shave|delete)\s+(?:the\s+)?(?:last|ending|outro|tail)\s+(.+)/
    );
    if (lastMatch) {
      const seconds = parseDuration(lastMatch[1]);
      if (seconds != null && seconds > 0) {
        candidates.push({
          op: { kind: "trim_last", seconds, sourceId: clauseSourceId },
          pattern: "edit.trim_last",
          confidence: 0.92
        });
      }
    }
  }

  // ---- drop_range ---------------------------------------------------
  if (hasVerbLemma(p, DROP_VERBS)) {
    const range = parseRange(p.lower);
    if (range && range.kind === "absolute") {
      candidates.push({
        op: {
          kind: "drop_range",
          startSeconds: range.startSeconds,
          endSeconds: range.endSeconds,
          sourceId: clauseSourceId
        },
        pattern: "edit.drop_range",
        confidence: 0.9
      });
    }
  }

  // ---- keep_range ---------------------------------------------------
  if (hasVerbLemma(p, KEEP_VERBS)) {
    const range = parseRange(p.lower);
    if (range && range.kind === "absolute") {
      candidates.push({
        op: {
          kind: "keep_range",
          startSeconds: range.startSeconds,
          endSeconds: range.endSeconds,
          sourceId: clauseSourceId
        },
        pattern: "edit.keep_range",
        confidence: 0.9
      });
    }
  }

  // ---- split_at / split_selected ------------------------------------
  if (hasVerbLemma(p, SPLIT_VERBS)) {
    // "split at 0:45" / "split at 1 minute"
    const atMatch = p.lower.match(
      /split\s+(?:at|@)\s+([\d.:a-z\s-]+?)(?:\s|$)/
    );
    if (atMatch) {
      const ts = parseTimestamp(atMatch[1].trim()) ?? parseDuration(atMatch[1]);
      if (ts != null && ts > 0) {
        candidates.push({
          op: { kind: "split_at", timeSeconds: ts, sourceId: clauseSourceId },
          pattern: "edit.split_at",
          confidence: 0.9
        });
      }
    }
    // "split this clip" / "split the selected clip" / "split it"
    const clipRef = resolveClipReference(p.lower, ctx);
    if (
      clipRef.resolved &&
      /split\s+(?:this|the\s+selected|it|the\s+clip)/.test(p.lower)
    ) {
      candidates.push({
        op: {
          kind: "split_selected",
          sourceId: ctx.highlights.find((h) => h.id === clipRef.clipId)
            ?.sourceId
        },
        pattern: "edit.split_selected",
        confidence: 0.88
      });
    }
  }

  // ---- reset_source -------------------------------------------------
  if (hasVerbLemma(p, RESET_VERBS)) {
    const sr = resolveSourceReference(p.lower, ctx);
    if (sr.resolved && sr.sourceIds.length === 1) {
      candidates.push({
        op: {
          kind: "reset_source",
          sourceId: sr.sourceIds[0]
        },
        pattern: "edit.reset_source",
        confidence: 0.88
      });
    }
  }

  if (candidates.length === 0) return null;

  // Multiple matches in one CLAUSE → too risky to short-circuit.
  // The cloud planner handles composite single-clause edit chains.
  if (candidates.length > 1) return null;

  return candidates[0];
}

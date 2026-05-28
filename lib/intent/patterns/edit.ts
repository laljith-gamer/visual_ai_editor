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
import { hasNegation, hasVerbLemma, type ParsedText } from "../grammar";
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

  // Each sub-pattern returns an EditOperation or null. We pick the
  // FIRST that matches; if multiple match (e.g. "trim first 30 and
  // drop 0:30 to 0:45"), we conservatively skip — composite edits
  // route to the cloud planner where intent is verified.
  const candidates: Array<{
    op: EditOperation;
    pattern: string;
    confidence: number;
  }> = [];

  // ---- trim_first / trim_last ---------------------------------------
  if (hasVerbLemma(p, TRIM_VERBS)) {
    const firstMatch = p.lower.match(
      /(?:trim|cut|remove|shorten|shave|delete)\s+(?:the\s+)?(?:first|opening|intro)\s+(.+)/
    );
    if (firstMatch) {
      const seconds = parseDuration(firstMatch[1]);
      if (seconds != null && seconds > 0) {
        candidates.push({
          op: { kind: "trim_first", seconds },
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
          op: { kind: "trim_last", seconds },
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
          endSeconds: range.endSeconds
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
          endSeconds: range.endSeconds
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
          op: { kind: "split_at", timeSeconds: ts },
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
    const sourceRef = resolveSourceReference(p.lower, ctx);
    if (sourceRef.resolved && sourceRef.sourceIds.length === 1) {
      candidates.push({
        op: {
          kind: "reset_source",
          sourceId: sourceRef.sourceIds[0]
        },
        pattern: "edit.reset_source",
        confidence: 0.88
      });
    }
  }

  if (candidates.length === 0) return null;

  // Multiple matches in one turn → too risky to short-circuit.
  // Cloud planner handles composite edit chains.
  if (candidates.length > 1) return null;

  const winner = candidates[0];
  return {
    kind: "edit",
    confidence: winner.confidence,
    patternId: winner.pattern,
    matchedText: p.raw,
    operations: [winner.op]
  };
}

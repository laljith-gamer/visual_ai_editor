import type { ParsedText } from "./grammar";
import { parseDuration, parseRange } from "./time";
import { resolveBriefingPartsReference, resolveSourceReference } from "./slots";
import type { QuickMatch, QuickMatchContext } from "./types";

const ADDITIVE_WORDS = ["add", "also", "include", "append", "put", "use"];
const ALL_WORDS = ["all", "every", "these", "those", "suggested", "recommended", "best"];
const BRIEFING_TARGET_WORDS = ["clip", "clips", "part", "parts", "moment", "moments", "highlight", "highlights"];
const FULL_SOURCE_WORDS = ["full", "whole", "entire", "complete", "as is", "as-is", "no edit", "no editing"];

const PROJECT_GRAMMAR_VARIANT_ESTIMATE =
  ADDITIVE_WORDS.length * ALL_WORDS.length * BRIEFING_TARGET_WORDS.length +
  FULL_SOURCE_WORDS.length * 12 +
  250;

export function matchProjectGrammar(
  p: ParsedText,
  ctx: QuickMatchContext
): QuickMatch | null {
  return (
    matchBriefingClipPromotion(p, ctx) ??
    matchDynamicTimeSlice(p, ctx) ??
    matchFullSourceMergeGuard(p, ctx)
  );
}

export function projectGrammarStats() {
  return {
    variantEstimate: PROJECT_GRAMMAR_VARIANT_ESTIMATE,
    strategy: "compact synonym grammar + slot parsers"
  };
}

function matchBriefingClipPromotion(
  p: ParsedText,
  ctx: QuickMatchContext
): QuickMatch | null {
  if (!ctx.lastBriefing || ctx.lastBriefing.bestParts.length === 0) return null;

  const lower = p.lower;
  const hasAdd = hasAnyWord(lower, ADDITIVE_WORDS) || /\bmake\b.*\b(?:reel|short|edit)\b/.test(lower);
  const hasAll = hasAnyWord(lower, ALL_WORDS) || /\ball\s+of\s+(?:them|these|those)\b/.test(lower);
  const hasTarget = hasAnyWord(lower, BRIEFING_TARGET_WORDS) || /\bbriefing\b|\bsuggestions?\b/.test(lower);
  const subsetRef = /\b(?:first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\b/.test(lower);

  if (!((hasAdd && hasTarget) || (hasAll && hasTarget) || subsetRef)) return null;

  const partsRef = resolveBriefingPartsReference(lower, ctx);
  if (partsRef.scope === "none") return null;

  const durMatch = lower.match(/(?:make|build|create)\s+(?:a\s+)?(.+?)\s+(?:reel|short|edit|version)/);
  const parsedDuration = durMatch ? parseDuration(durMatch[1]) : null;

  return {
    kind: "promote",
    confidence: partsRef.scope === "subset" ? 0.94 : 0.96,
    patternId: `project.promote_${partsRef.scope}`,
    matchedText: p.raw,
    partIds:
      partsRef.scope === "subset" && partsRef.partIds.length > 0
        ? partsRef.partIds
        : undefined,
    targetSeconds: parsedDuration && parsedDuration > 0 ? parsedDuration : undefined,
    op: /\b(?:instead|replace|fresh|start\s+over)\b/.test(lower) ? "replace" : "append"
  };
}

function matchDynamicTimeSlice(
  p: ParsedText,
  ctx: QuickMatchContext
): QuickMatch | null {
  if (ctx.sources.length === 0) return null;
  const range = parseRange(p.lower);
  if (!range) return null;

  const sourceRef = resolveSourceReference(p.lower, ctx);
  const sourceId =
    sourceRef.sourceIds.length === 1 ? sourceRef.sourceIds[0] : undefined;

  const isAppend = /\b(?:add|also|append|include)\b/.test(p.lower);
  if (!isAppend) {
    return {
      kind: "extract",
      confidence: sourceId ? 0.94 : 0.9,
      patternId: `project.extract_${range.kind}_replace`,
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

  const targetSourceId = sourceId ?? (ctx.selectedSourceIds.length === 1 ? ctx.selectedSourceIds[0] : ctx.sources[0]?.id);
  const source = ctx.sources.find((s) => s.id === targetSourceId);
  if (!source) return null;

  const dur = source.meta.duration;
  if (!Number.isFinite(dur) || dur <= 0) return null;

  let startSeconds = range.startSeconds;
  let endSeconds = range.endSeconds;
  if (range.kind === "first") {
    startSeconds = 0;
    endSeconds = Math.min(dur, range.endSeconds);
  } else if (range.kind === "last") {
    const length = Math.max(0, range.endSeconds - range.startSeconds);
    endSeconds = dur;
    startSeconds = Math.max(0, dur - length);
  } else {
    startSeconds = Math.max(0, Math.min(dur, startSeconds));
    endSeconds = Math.max(0, Math.min(dur, endSeconds));
  }

  if (endSeconds <= startSeconds + 0.1) return null;

  return {
    kind: "merge",
    confidence: 0.93,
    patternId: "project.append_time_slice",
    matchedText: p.raw,
    sourceIds: [source.id],
    transition: "none",
    op: "append",
    sourceRanges: [{ sourceId: source.id, startSeconds, endSeconds }]
  };
}

function matchFullSourceMergeGuard(
  p: ParsedText,
  ctx: QuickMatchContext
): QuickMatch | null {
  if (ctx.sources.length === 0) return null;
  const lower = p.lower;
  const hasMergeVerb = /\b(?:merge|join|stitch|combine|concat|concatenate)\b/.test(lower);
  const hasFullSource = hasAnyPhrase(lower, FULL_SOURCE_WORDS) || /\b(?:video|videos|source|sources|footage)\b/.test(lower);
  if (!hasMergeVerb || !hasFullSource) return null;

  const sourceRef = resolveSourceReference(lower, ctx);
  return {
    kind: "merge",
    confidence: 0.91,
    patternId: "project.merge_full_source",
    matchedText: p.raw,
    sourceIds: sourceRef.sourceIds.length > 0 ? sourceRef.sourceIds : undefined,
    transition: "none",
    op: /\b(?:also|append|include)\b/.test(lower) ? "append" : "replace"
  };
}

function hasAnyWord(text: string, words: string[]): boolean {
  return words.some((w) => new RegExp(`\\b${escapeRegExp(w)}\\b`).test(text));
}

function hasAnyPhrase(text: string, phrases: string[]): boolean {
  return phrases.some((p) => text.includes(p));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

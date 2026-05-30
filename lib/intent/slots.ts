/**
 * v1.7.5 — Slot extractors.
 *
 * Resolves video-editing-specific entities from raw text + the editor
 * context. These are the parts that go into a QuickMatch envelope:
 *
 *   - source references: "the second video", "video 2", "the podcast"
 *   - clip references:   "this clip", "the selected clip", "clip 3"
 *   - briefing-part refs: "the second one", "first three"
 *   - transition cues:   "with a fade", "no transition"
 *   - op cues:           "instead", "also", "add"
 *
 * Pure functions; no side effects. Easy to test in isolation from the
 * dev tester page.
 */

import { ORDINAL_TO_INDEX } from "./dictionary";
import type { QuickMatchContext } from "./types";

// ---------------------------------------------------------------------
// Source references
// ---------------------------------------------------------------------

interface SourceRef {
  /** Resolved source ids in the order the user named them. */
  sourceIds: string[];
  /** Whether ANY explicit reference was found (so we can distinguish
   *  "all selected" default from a "specific" pick). */
  resolved: boolean;
}

/** Resolve user phrasings that name specific sources. Falls back to
 *  empty when nothing matches; the caller treats that as "use the
 *  default selection". */
export function resolveSourceReference(
  lower: string,
  ctx: QuickMatchContext
): SourceRef {
  const hits: string[] = [];

  // 1. Ordinal: "the second video" / "the third one" / "first source"
  //    Find ALL ordinals in order so "the first then the second"
  //    yields [0, 1] in the right concatenation order.
  const ordRegex = /(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th)\s+(?:video|clip|source|one)\b/g;
  let ordMatch: RegExpExecArray | null;
  while ((ordMatch = ordRegex.exec(lower)) !== null) {
    const idx = ORDINAL_TO_INDEX[ordMatch[1].toLowerCase()];
    if (idx != null && idx < ctx.sources.length) {
      pushUnique(hits, ctx.sources[idx].id);
    }
  }

  // 2. Numeric: "video 2" / "clip 3"
  const numRegex = /\b(?:video|clip|source)\s+(\d+)\b/g;
  let numMatch: RegExpExecArray | null;
  while ((numMatch = numRegex.exec(lower)) !== null) {
    const idx = parseInt(numMatch[1], 10) - 1;
    if (idx >= 0 && idx < ctx.sources.length) {
      pushUnique(hits, ctx.sources[idx].id);
    }
  }

  // 3. Name match (last resort): pull a tail word and look for a
  //    source whose meta.name contains it case-insensitively. This
  //    is best-effort — we only fire when the matching word is at
  //    least 4 chars to avoid false positives on common short tokens
  //    ("the" / "and" / "video" itself).
  if (hits.length === 0) {
    const namedRefs = lower.match(/\bthe\s+([a-z]{4,})\b/g);
    if (namedRefs) {
      for (const ref of namedRefs) {
        const word = ref.replace(/^the\s+/, "");
        const match = ctx.sources.find((s) =>
          s.meta.name.toLowerCase().includes(word)
        );
        if (match) pushUnique(hits, match.id);
      }
    }
  }

  return { sourceIds: hits, resolved: hits.length > 0 };
}

function pushUnique(arr: string[], v: string): void {
  if (!arr.includes(v)) arr.push(v);
}

// ---------------------------------------------------------------------
// Clip references (for edit + describe-style intents)
// ---------------------------------------------------------------------

export interface ClipRef {
  clipId: string | null;
  resolved: boolean;
}

export function resolveClipReference(
  lower: string,
  ctx: QuickMatchContext
): ClipRef {
  // "this clip" / "the selected clip" / "currently selected"
  if (
    /(?:this\s+clip|the\s+selected\s+clip|currently\s+selected\s+clip|the\s+clip)/.test(
      lower
    )
  ) {
    return {
      clipId: ctx.selectedClipId,
      resolved: !!ctx.selectedClipId
    };
  }

  // "clip N"
  const numMatch = lower.match(/clip\s+(\d+)/);
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1;
    if (idx >= 0 && idx < ctx.highlights.length) {
      return { clipId: ctx.highlights[idx].id, resolved: true };
    }
  }

  return { clipId: null, resolved: false };
}

// ---------------------------------------------------------------------
// Briefing-part references (for promote intent)
// ---------------------------------------------------------------------

export interface BriefingPartsRef {
  partIds: string[];
  /** "all" — user said "those" / "the briefing" with no numeric narrow.
   *  "subset" — specific ordinals were named.
   *  "none" — couldn't resolve. */
  scope: "all" | "subset" | "none";
}

export function resolveBriefingPartsReference(
  lower: string,
  ctx: QuickMatchContext
): BriefingPartsRef {
  const briefing = ctx.lastBriefing;
  if (!briefing || briefing.bestParts.length === 0) {
    return { partIds: [], scope: "none" };
  }

  const ids: string[] = [];

  // 1. Ordinal references: "the second one" / "first three"
  const ordRegex = /(?:the\s+)?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+(?:one|part|moment|clip)?/g;
  let m: RegExpExecArray | null;
  while ((m = ordRegex.exec(lower)) !== null) {
    const idx = ORDINAL_TO_INDEX[m[1].toLowerCase()];
    if (idx != null && idx < briefing.bestParts.length) {
      pushUnique(ids, briefing.bestParts[idx].id);
    }
  }

  // 2. "first N" / "first three" → range from 0..N-1
  const firstNMatch = lower.match(
    /first\s+(\d+|two|three|four|five|six|seven|eight|nine|ten)\b/
  );
  if (firstNMatch && ids.length === 0) {
    const word = firstNMatch[1].toLowerCase();
    const n = ORDINAL_TO_INDEX[word] != null ? ORDINAL_TO_INDEX[word] + 1 : parseInt(word, 10);
    if (n > 0) {
      for (let i = 0; i < Math.min(n, briefing.bestParts.length); i++) {
        pushUnique(ids, briefing.bestParts[i].id);
      }
    }
  }

  // 3. "numbers two and four" / "two and four"
  const numAndRegex = /\b(\d+)\s+and\s+(\d+)\b/;
  const naMatch = lower.match(numAndRegex);
  if (naMatch && ids.length === 0) {
    const a = parseInt(naMatch[1], 10) - 1;
    const b = parseInt(naMatch[2], 10) - 1;
    [a, b].forEach((idx) => {
      if (idx >= 0 && idx < briefing.bestParts.length) {
        pushUnique(ids, briefing.bestParts[idx].id);
      }
    });
  }

  if (ids.length > 0) {
    return { partIds: ids, scope: "subset" };
  }

  // 4. Bulk references after a briefing. These phrases mean the curated
  //    briefing moments, not the full source video.
  if (
    /(?:those|them|these|all\s+of\s+them|the\s+briefing|the\s+(?:best\s+)?parts|the\s+moments|the\s+suggestions)/.test(
      lower
    ) ||
    /(?:all|these|those|the|suggested|best)\s+(?:best\s+)?(?:clips?|parts?|moments?)/.test(
      lower
    ) ||
    /(?:clips?|parts?|moments?)\s+(?:to|into|onto)\s+(?:the\s+)?timeline/.test(
      lower
    )
  ) {
    return {
      partIds: briefing.bestParts.map((p) => p.id),
      scope: "all"
    };
  }

  return { partIds: [], scope: "none" };
}

// ---------------------------------------------------------------------
// Transition + op resolvers
// ---------------------------------------------------------------------

export function resolveTransition(
  lower: string
): "none" | "fade" | "crossfade" {
  if (/no\s+(?:edit|effect|transition|fade|cut)/.test(lower)) return "none";
  if (/crossfade|cross-fade/.test(lower)) return "crossfade";
  if (/with\s+(?:a\s+)?fade|fade\s+(?:between|in|out)|fades?\s+between/.test(lower)) return "fade";
  return "none";
}

export function resolveOp(lower: string): "append" | "replace" {
  if (/instead|replace|start\s+over|reset|wipe|fresh/.test(lower)) return "replace";
  if (/also|too|add\s+(?:to|onto)?|include|append|on\s+top|alongside/.test(lower)) {
    return "append";
  }
  return "replace"; // default — most "merge"/"promote" turns expect a clean result
}

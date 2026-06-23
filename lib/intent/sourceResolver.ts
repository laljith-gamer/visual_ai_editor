/**
 * Phase 1 — source resolution.
 *
 * Two layers:
 *   - `parseSourceRef(text)` — pure: turn phrasing into an unresolved
 *     `SourceRef` ("video 2" → index 1) or null.
 *   - `resolveSource(ref, ctx)` — resolve a ref (or, when absent, infer)
 *     into concrete source ids with confidence + assumptions, following
 *     the project's rules:
 *
 *       1. One video uploaded + no named source → assume that video.
 *       2. Multiple videos + named source → use it.
 *       2b. Multiple videos, no named source, but the user has selected
 *           videos in the Library → honor that selection (no clarify).
 *       3. Multiple videos + unnamed but a high-confidence active /
 *          last-used source → use it (surfaced as an assumption).
 *       4. Otherwise → needsClarification.
 *
 * No hidden defaults: every non-explicit choice is recorded in
 * `assumptions` so the UI can show "Using video 2 because …".
 */

import { ORDINAL_TO_INDEX } from "./dictionary";
import type { AgentCommandContext, SourceRef } from "./command";

/** Parse a source reference from raw text. Returns null when no explicit
 *  source was named (the caller then infers from context). */
export function parseSourceRef(text: string): SourceRef | null {
  if (!text) return null;
  const lower = text.toLowerCase();

  // "video 2" / "source 3" / "clip 2 from video 1" (the numeric video).
  const num = lower.match(/\b(?:video|source|upload|file)\s+(\d+)\b/);
  if (num) {
    const idx = parseInt(num[1], 10) - 1;
    if (idx >= 0) return { kind: "index", index: idx, spoken: num[0] };
  }

  // "the second video" / "first source" / "third one".
  const ord = lower.match(
    /\b(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th)\s+(?:video|source|upload|file|clip|one)\b/
  );
  if (ord) {
    const idx = ORDINAL_TO_INDEX[ord[1]];
    if (idx != null) return { kind: "index", index: idx, spoken: ord[0] };
  }

  // "all videos" / "every video" / "both videos".
  if (/\b(?:all|every|both)\s+(?:the\s+)?(?:videos?|sources?|clips?|uploads?|footage)\b/.test(lower)) {
    return { kind: "all", spoken: "all videos" };
  }

  // "the selected videos".
  if (/\bselected\s+(?:videos?|sources?)\b/.test(lower)) {
    return { kind: "selected", spoken: "selected videos" };
  }

  // "this video" / "current video" / "the active one".
  if (/\b(?:this|current|active)\s+(?:video|source|one|clip)\b/.test(lower)) {
    return { kind: "active", spoken: "this video" };
  }

  // "that video" / "the one I used" / "the last video".
  if (/\b(?:that\s+video|that\s+source|the\s+last\s+video|the\s+one\s+i\s+used|the\s+previous\s+video)\b/.test(lower)) {
    return { kind: "last_used", spoken: "that video" };
  }

  // Fuzzy filename: "the podcast", "the gameplay one". Only fire when a
  // 4+ char content word follows "the" so we don't grab stopwords.
  const named = lower.match(/\bthe\s+([a-z]{4,})(?:\s+(?:video|clip|one|footage))?\b/);
  if (named && !isCommonWord(named[1])) {
    return { kind: "name_hint", hint: named[1], spoken: named[0] };
  }

  return null;
}

const COMMON_WORDS = new Set([
  "best",
  "first",
  "last",
  "next",
  "same",
  "other",
  "whole",
  "full",
  "part",
  "parts",
  "middle",
  "intro",
  "ending",
  "start",
  "good",
  "more",
  "less",
  "left",
  "right"
]);

function isCommonWord(w: string): boolean {
  return COMMON_WORDS.has(w);
}

export interface SourceResolution {
  sourceIds: string[];
  confidence: number;
  assumptions: string[];
  needsClarification: boolean;
  clarification?: string;
  suggestions?: string[];
}

/**
 * Resolve a (possibly null) source ref into concrete source ids.
 *
 * When `ref` is null the resolver infers a source from context per the
 * rules above, recording assumptions. Multi-source ambiguity returns
 * `needsClarification: true` with quick-reply suggestions.
 */
export function resolveSource(
  ref: SourceRef | null,
  ctx: AgentCommandContext
): SourceResolution {
  const sources = ctx.sources;

  if (sources.length === 0) {
    return {
      sourceIds: [],
      confidence: 0,
      assumptions: [],
      needsClarification: true,
      clarification: "Upload a video first, then tell me what to do.",
      suggestions: []
    };
  }

  // ---- Explicit reference ------------------------------------------
  if (ref) {
    switch (ref.kind) {
      case "all":
        return { sourceIds: sources.map((s) => s.id), confidence: 0.95, assumptions: [], needsClarification: false };
      case "selected": {
        const ids = ctx.selectedSourceIds.length > 0 ? ctx.selectedSourceIds : sources.map((s) => s.id);
        return { sourceIds: ids, confidence: 0.9, assumptions: [], needsClarification: false };
      }
      case "index": {
        const src = sources[ref.index];
        if (src) return { sourceIds: [src.id], confidence: 0.95, assumptions: [], needsClarification: false };
        return ambiguous(ctx, `There's no ${ordinalLabel(ref.index)} video — you have ${sources.length}.`);
      }
      case "active": {
        const id = ctx.activeSourceId ?? sources[0]?.id;
        return id
          ? { sourceIds: [id], confidence: 0.9, assumptions: [], needsClarification: false }
          : ambiguous(ctx, "I'm not sure which video is active.");
      }
      case "last_used": {
        const id = ctx.lastUsedSourceId ?? ctx.activeSourceId;
        if (id) {
          const name = nameOf(ctx, id);
          return {
            sourceIds: [id],
            confidence: 0.82,
            assumptions: [`Using "${name}" — the video you last worked on.`],
            needsClarification: false
          };
        }
        return ambiguous(ctx, "I'm not sure which video you mean by that.");
      }
      case "name_hint": {
        const matches = sources.filter((s) => s.name.toLowerCase().includes(ref.hint));
        if (matches.length === 1) {
          return { sourceIds: [matches[0].id], confidence: 0.85, assumptions: [], needsClarification: false };
        }
        if (matches.length > 1) {
          return ambiguous(ctx, `More than one video matches "${ref.hint}". Which one?`);
        }
        // Hint matched nothing — fall through to inference below.
        break;
      }
    }
  }

  // ---- Inference (no explicit, resolvable reference) ----------------
  // Rule 1: exactly one video → assume it, no clarification needed.
  if (sources.length === 1) {
    return { sourceIds: [sources[0].id], confidence: 0.92, assumptions: [], needsClarification: false };
  }

  // Rule 2: the user has ALREADY chosen which videos the AI should use via
  // the Library selection. That explicit choice IS the answer — honor it
  // instead of asking "Which video?" (the source of the clarify loop). Only
  // count still-present sources. A strict subset is surfaced as an
  // assumption; selecting everything is the natural multi-video default.
  const selected = ctx.selectedSourceIds.filter((id) => sources.some((s) => s.id === id));
  if (selected.length >= 1) {
    if (selected.length === sources.length) {
      return {
        sourceIds: selected,
        confidence: 0.85,
        assumptions:
          selected.length > 1 ? [`Using all ${selected.length} videos you've selected.`] : [],
        needsClarification: false
      };
    }
    return {
      sourceIds: selected,
      confidence: 0.82,
      assumptions: [
        `Using the ${selected.length} video${selected.length === 1 ? "" : "s"} you selected for AI.`
      ],
      needsClarification: false
    };
  }

  // Rule 3: multiple videos, no name → lean on active / last-used, but
  // at MEDIUM confidence so the orchestrator surfaces the assumption.
  const inferredId = ctx.activeSourceId ?? ctx.lastUsedSourceId;
  if (inferredId) {
    const name = nameOf(ctx, inferredId);
    const why =
      inferredId === ctx.lastUsedSourceId && inferredId !== ctx.activeSourceId
        ? "it was the last source you edited"
        : "it's the active video";
    return {
      sourceIds: [inferredId],
      confidence: 0.7,
      assumptions: [`Using "${name}" because ${why}.`],
      needsClarification: false
    };
  }

  // Rule 4: genuinely ambiguous.
  return ambiguous(ctx, "Which video should I use?");
}

function ambiguous(ctx: AgentCommandContext, message: string): SourceResolution {
  return {
    sourceIds: [],
    confidence: 0.3,
    assumptions: [],
    needsClarification: true,
    clarification: message,
    suggestions: ctx.sources.slice(0, 4).map((s, i) => `Video ${i + 1} (${s.name})`)
  };
}

function nameOf(ctx: AgentCommandContext, id: string): string {
  return ctx.sources.find((s) => s.id === id)?.name ?? "that video";
}

function ordinalLabel(idx: number): string {
  const words = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
  return words[idx] ?? `${idx + 1}th`;
}

/**
 * Phase 5 — concept resolver.
 *
 * Resolves a semantic concept ("the part where he says subscribe",
 * "best cooking parts", "the screen where it says SALE") into concrete
 * time ranges, following a strict, HONEST search order:
 *
 *   1. Exact time range, if the user gave one (handled upstream as
 *      add_range; included here for completeness when a replacement
 *      carries a range).
 *   2. Transcript / ASR match — when a local Whisper transcript exists
 *      and the concept words appear in speech.
 *   3. OCR match — ONLY when the request is about on-screen TEXT and an
 *      OCR engine is actually available. It isn't yet (lib/ocr), so this
 *      returns "unavailable" and we fall back — we never pretend to read
 *      the screen.
 *   4. Video-memory tree (tags/summaries) — when an index is provided.
 *   5/6. Visual semantic / motion-saliency — these need the heavy frame
 *      pipeline, which lives in the editor. The resolver does NOT run it;
 *      it returns `needsVisualAnalysis: true` so the caller routes the
 *      turn through the existing pipeline (no duplicated/faked vision).
 *
 * Generic "best parts" with no concept words → straight to visual/motion
 * (no transcript), with NO hardcoded clip count or duration.
 */

import type { Transcript } from "@/lib/audio/types";
import { queryOnScreenText } from "@/lib/ocr/query";
import { AGENT_GUARDRAILS } from "@/lib/config";

export type ConceptEvidence = "range" | "transcript" | "ocr" | "video-memory" | "vision" | "motion";

export interface ConceptMatch {
  sourceId: string;
  start: number;
  end: number;
  confidence: number;
  evidenceType: ConceptEvidence;
  reason: string;
}

export interface ResolveConceptArgs {
  concept: string;
  sourceId: string;
  durationSeconds: number;
  /** Local transcript for the source, if available. */
  transcript?: Transcript | null;
  /** When the user gave an exact range for this concept (e.g. a
   *  replacement "with 0:30 to 0:45"). */
  exactRange?: { start: number; end: number } | null;
}

export interface ConceptResolution {
  matches: ConceptMatch[];
  /** True when no deterministic (range/transcript/ocr/memory) match was
   *  found and the caller should run the visual pipeline. */
  needsVisualAnalysis: boolean;
  /** True when the request was about on-screen text but OCR isn't ready. */
  ocrUnavailable: boolean;
  /** Human-readable explanation for chat. */
  reason: string;
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "for", "with", "from",
  "is", "it", "this", "that", "where", "when", "he", "she", "they", "him", "her",
  "part", "parts", "bit", "bits", "moment", "moments", "section", "clip", "clips",
  "scene", "scenes", "best", "good", "show", "me", "find", "add", "pick", "get",
  "says", "said", "talk", "talks", "talking", "screen", "text", "caption", "title"
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/g)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && !STOPWORDS.has(s));
}

/** Is the user asking about on-screen TEXT (→ OCR) vs spoken words / a
 *  visual scene? */
function isOnScreenTextRequest(concept: string): boolean {
  return /\b(?:screen|text|caption|title|sign|written|reads?|displays?|on[\s-]?screen|subtitle)\b/.test(
    concept.toLowerCase()
  );
}

/** Is this a generic "best/interesting parts" ask (no concept words)? */
function isGeneric(concept: string): boolean {
  return tokenize(concept).length === 0;
}

export async function resolveConcept(args: ResolveConceptArgs): Promise<ConceptResolution> {
  const { concept, sourceId, durationSeconds } = args;

  // 1. Exact range wins.
  if (args.exactRange) {
    return {
      matches: [
        {
          sourceId,
          start: args.exactRange.start,
          end: args.exactRange.end,
          confidence: 0.95,
          evidenceType: "range",
          reason: "Exact time range you specified"
        }
      ],
      needsVisualAnalysis: false,
      ocrUnavailable: false,
      reason: "Using the exact range you gave."
    };
  }

  // Generic "best parts" → visual/motion path, no transcript, no count.
  if (isGeneric(concept)) {
    return {
      matches: [],
      needsVisualAnalysis: true,
      ocrUnavailable: false,
      reason: "Scanning the footage for the strongest moments."
    };
  }

  // 3. On-screen text → OCR (honest fallback when unavailable).
  let ocrUnavailable = false;
  if (isOnScreenTextRequest(concept)) {
    const ocr = await queryOnScreenText({ query: concept, sourceId });
    if (ocr.available && ocr.hits.length > 0) {
      return {
        matches: ocr.hits.slice(0, AGENT_GUARDRAILS.maxConceptMatchesPerTurn).map((h) => ({
          sourceId: h.sourceId ?? sourceId,
          start: h.start,
          end: h.end,
          confidence: h.confidence,
          evidenceType: "ocr" as const,
          reason: `On-screen text: "${h.text}"`
        })),
        needsVisualAnalysis: false,
        ocrUnavailable: false,
        reason: "Matched on-screen text."
      };
    }
    ocrUnavailable = true;
    // fall through to transcript / visual.
  }

  // 2. Transcript match.
  const transcriptMatches = matchTranscript(concept, sourceId, args.transcript, durationSeconds);
  if (transcriptMatches.length > 0) {
    return {
      matches: transcriptMatches,
      needsVisualAnalysis: false,
      ocrUnavailable,
      reason: ocrUnavailable
        ? "OCR isn't ready, but I found it in the spoken transcript."
        : "Matched the spoken transcript."
    };
  }

  // 4/5/6. Nothing deterministic → visual pipeline.
  return {
    matches: [],
    needsVisualAnalysis: true,
    ocrUnavailable,
    reason: ocrUnavailable
      ? "OCR isn't ready and there's no transcript match \u2014 I'll scan the footage visually."
      : "No transcript match \u2014 I'll scan the footage visually."
  };
}

function matchTranscript(
  concept: string,
  sourceId: string,
  transcript: Transcript | null | undefined,
  durationSeconds: number
): ConceptMatch[] {
  if (!transcript || transcript.segments.length === 0) return [];
  const keywords = tokenize(concept);
  if (keywords.length === 0) return [];

  const scored: ConceptMatch[] = [];
  for (const seg of transcript.segments) {
    const segTokens = new Set(tokenize(seg.text));
    if (segTokens.size === 0) continue;
    let hits = 0;
    for (const k of keywords) if (segTokens.has(k)) hits += 1;
    if (hits === 0) continue;
    const ratio = hits / keywords.length;
    const confidence = Math.min(0.95, 0.55 + ratio * 0.4);
    scored.push({
      sourceId,
      start: round2(clamp(seg.start - 0.25, 0, durationSeconds)),
      end: round2(clamp(seg.end + 0.35, 0, durationSeconds)),
      confidence,
      evidenceType: "transcript",
      reason: `Transcript match: "${truncate(seg.text, 70)}"`
    });
  }
  return scored
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, AGENT_GUARDRAILS.maxConceptMatchesPerTurn);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function truncate(s: string, n: number): string {
  const c = s.replace(/\s+/g, " ").trim();
  return c.length <= n ? c : `${c.slice(0, n - 1)}\u2026`;
}

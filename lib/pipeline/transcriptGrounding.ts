import type { EditPlan, FrameScore, Highlight, SignalWeights } from "@/lib/types";
import type { Transcript, TranscriptSegment } from "@/lib/audio/types";
import { SIGNAL_DEFAULTS } from "@/lib/config";

const TRANSCRIPT_LABEL_ID = "__transcript";
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "best",
  "clip",
  "clips",
  "find",
  "for",
  "from",
  "get",
  "give",
  "highlight",
  "highlights",
  "in",
  "is",
  "it",
  "me",
  "moment",
  "moments",
  "of",
  "on",
  "part",
  "parts",
  "pick",
  "reel",
  "short",
  "shorts",
  "show",
  "the",
  "this",
  "to",
  "video",
  "where",
  "with"
]);

interface MatchResult {
  segment: TranscriptSegment;
  score: number;
  query: string;
}

/**
 * Boost frame scores with local transcript matches.
 *
 * This does not replace visual scoring. It gives the selector a precise
 * text/speech anchor when the user's scenario contains words that appear in
 * the local Whisper transcript, so prompts like "clip the part where he says
 * subscribe" land near the transcript segment instead of only relying on
 * motion/saliency/SigLIP.
 */
export function applyTranscriptGrounding(
  frames: FrameScore[],
  plan: EditPlan,
  transcript?: Transcript | null
): FrameScore[] {
  if (!transcript || transcript.segments.length === 0 || plan.scenarios.length === 0) {
    return frames;
  }

  const weights = resolveSignalWeights(plan);
  return frames.map((frame) => {
    const match = bestTranscriptMatchAt(frame.t, plan, transcript);
    if (!match || match.score <= 0) return frame;

    const semantic = Math.max(frame.semantic ?? 0, match.score);
    return {
      ...frame,
      labels: {
        ...frame.labels,
        [TRANSCRIPT_LABEL_ID]: match.score
      },
      semantic,
      score: composite(semantic, frame.motion ?? 0, frame.saliency ?? 0, weights)
    };
  });
}

/**
 * Snap clips to transcript segment boundaries when the clip overlaps or sits
 * very close to a strong transcript match for the active scenario. This makes
 * text/speech-driven clips use concrete start/end times from Whisper chunks.
 */
export function snapHighlightsToTranscriptMatches(
  highlights: Highlight[],
  plan: EditPlan,
  transcript: Transcript | null | undefined,
  videoDuration: number
): Highlight[] {
  if (!transcript || transcript.segments.length === 0 || plan.scenarios.length === 0) {
    return highlights;
  }

  return highlights.map((highlight) => {
    const match = bestTranscriptMatchInRange(highlight.start, highlight.end, plan, transcript);
    if (!match || match.score < 0.6) return highlight;

    const start = round2(clamp(match.segment.start - 0.25, 0, videoDuration));
    const end = round2(clamp(match.segment.end + 0.35, start + 0.5, videoDuration));
    return {
      ...highlight,
      start,
      end,
      reason: `Transcript match: "${truncate(match.segment.text, 80)}"`,
      label: highlight.label ?? match.query,
      confidence: highlight.confidence === "low" ? "medium" : highlight.confidence
    };
  });
}

export function transcriptSignature(transcript?: Transcript | null): string {
  if (!transcript || transcript.segments.length === 0) return "transcript:none";
  return [
    "transcript:v1",
    transcript.model,
    transcript.ts,
    transcript.segments.length,
    transcript.fullText.length
  ].join(":");
}

function bestTranscriptMatchAt(
  t: number,
  plan: EditPlan,
  transcript: Transcript
): MatchResult | null {
  let best: MatchResult | null = null;
  for (const segment of transcript.segments) {
    // Keep a small timing halo because sampled frames may be 1s+ apart.
    if (t < segment.start - 1 || t > segment.end + 1) continue;
    const match = scoreSegment(segment, plan);
    if (match && (!best || match.score > best.score)) best = match;
  }
  return best;
}

function bestTranscriptMatchInRange(
  start: number,
  end: number,
  plan: EditPlan,
  transcript: Transcript
): MatchResult | null {
  let best: MatchResult | null = null;
  for (const segment of transcript.segments) {
    const overlap = Math.max(0, Math.min(end, segment.end) - Math.max(start, segment.start));
    const near = segment.start <= end + 1.5 && segment.end >= start - 1.5;
    if (overlap <= 0 && !near) continue;
    const match = scoreSegment(segment, plan);
    if (match && (!best || match.score > best.score)) best = match;
  }
  return best;
}

function scoreSegment(segment: TranscriptSegment, plan: EditPlan): MatchResult | null {
  const segmentTokens = new Set(tokenize(segment.text));
  if (segmentTokens.size === 0) return null;

  let best: MatchResult | null = null;
  for (const scenario of plan.scenarios) {
    const queryTokens = tokenize(scenario.prompt);
    if (queryTokens.length === 0) continue;
    let hits = 0;
    for (const token of queryTokens) {
      if (segmentTokens.has(token)) hits += 1;
    }
    if (hits === 0) continue;
    const ratio = hits / queryTokens.length;
    const score = Math.min(1, 0.45 + ratio * 0.55);
    const match = { segment, score, query: scenario.prompt };
    if (!best || match.score > best.score) best = match;
  }
  return best;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/g)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && !STOPWORDS.has(s));
}

function resolveSignalWeights(plan: EditPlan): SignalWeights {
  if (plan.signals) {
    const w = plan.signals;
    const sum = w.semantic + w.motion + w.saliency;
    if (sum > 0) {
      return {
        semantic: w.semantic / sum,
        motion: w.motion / sum,
        saliency: w.saliency / sum
      };
    }
  }
  if (plan.scenarios.length === 0) return SIGNAL_DEFAULTS.visualInterest;
  return SIGNAL_DEFAULTS.scenarioHeavy;
}

function composite(semantic: number, motion: number, saliency: number, w: SignalWeights): number {
  return Math.max(0, Math.min(1, w.semantic * semantic + w.motion * motion + w.saliency * saliency));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/**
 * PR 59 — clip-pair transition features.
 *
 * Extracts GENERIC, evidence-based signals about the boundary between two
 * adjacent clips. The auto-transition selector (lib/transitions/auto.ts)
 * reads ONLY these signals — never a genre/keyword table. Everything here
 * is optional/nullable and degrades gracefully: missing transcript, tree,
 * or motion data simply leaves the corresponding feature `null` and the
 * selector falls back to whatever IS known (at worst: same-source +
 * time-gap, which is always available from the timeline).
 *
 * Pure + dependency-light (type-only imports) so it is unit-testable with
 * `node --test`.
 */

/** Minimal clip shape the feature extractor needs. Compatible with
 *  `Highlight` but intentionally narrow + decoupled from the store. */
export interface TransitionClip {
  id: string;
  start: number;
  end: number;
  sourceId?: string;
  label?: string;
  /** Optional precomputed motion (0..1) for the clip, if the pipeline has it. */
  motion?: number | null;
  /** Optional precomputed saliency (0..1) for the clip, if available. */
  saliency?: number | null;
}

/**
 * Optional context resolvers. ALL optional — the editor wires whichever
 * data exists (transcript store, VideoMemory tree, user preference); when a
 * resolver is absent the related feature is null. No resolver may throw;
 * the extractor also guards each call.
 */
export interface TransitionContext {
  /** Words spoken inside [start,end] on a source, for transcript overlap. */
  getTranscriptText?: (clip: TransitionClip) => string | null | undefined;
  /** Stable scene id covering the clip, if a scene tree exists. */
  getSceneId?: (clip: TransitionClip) => string | null | undefined;
  /** Stable chapter id covering the clip, if a chapter tree exists. */
  getChapterId?: (clip: TransitionClip) => string | null | undefined;
  /** Motion (0..1) for the clip when not already on the clip object. */
  getMotion?: (clip: TransitionClip) => number | null | undefined;
  /** Saliency (0..1) for the clip when not already on the clip object. */
  getSaliency?: (clip: TransitionClip) => number | null | undefined;
  /** User asked for smooth/cinematic transitions. */
  userPreferredSmooth?: boolean;
  /** User asked for fast/punchy cuts. */
  userPreferredFastCuts?: boolean;
}

export interface TransitionFeatures {
  sameSource: boolean;
  sourceChanged: boolean;
  /** prev.end → next.start gap in seconds; null when sources differ. */
  timeGapSeconds: number | null;
  temporallyAdjacent: boolean;
  prevMotion: number | null;
  nextMotion: number | null;
  motionContrast: number | null;
  prevSaliency: number | null;
  nextSaliency: number | null;
  saliencyContrast: number | null;
  /** 0..1 word overlap between the two clips' transcript text; null if absent. */
  transcriptOverlap: number | null;
  /** 0..1 token overlap between the two clips' labels/tags; null if absent. */
  tagOverlap: number | null;
  sameScene: boolean | null;
  sameChapter: boolean | null;
  userPreferredSmooth: boolean;
  userPreferredFastCuts: boolean;
  evidence: string[];
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "for", "with",
  "from", "is", "it", "this", "that", "clip", "moment", "moments", "part",
  "scene", "best", "video"
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/g)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/** Jaccard overlap of two token sets, or null when either side is empty. */
function jaccard(a: string[], b: string[]): number | null {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return null;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? null : round2(inter / union);
}

/** Safe numeric resolution: clip field first, then context resolver. */
function resolveSignal(
  onClip: number | null | undefined,
  resolver: ((c: TransitionClip) => number | null | undefined) | undefined,
  clip: TransitionClip
): number | null {
  if (typeof onClip === "number" && isFinite(onClip)) return clamp01(onClip);
  if (resolver) {
    try {
      const v = resolver(clip);
      if (typeof v === "number" && isFinite(v)) return clamp01(v);
    } catch {
      /* resolver must never break feature extraction */
    }
  }
  return null;
}

function safeText(
  resolver: ((c: TransitionClip) => string | null | undefined) | undefined,
  clip: TransitionClip
): string | null {
  if (!resolver) return null;
  try {
    const v = resolver(clip);
    return typeof v === "string" && v.trim() ? v : null;
  } catch {
    return null;
  }
}

function safeId(
  resolver: ((c: TransitionClip) => string | null | undefined) | undefined,
  clip: TransitionClip
): string | null {
  if (!resolver) return null;
  try {
    const v = resolver(clip);
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

export function buildTransitionFeatures(
  prevClip: TransitionClip,
  nextClip: TransitionClip,
  context: TransitionContext = {}
): TransitionFeatures {
  const evidence: string[] = [];

  const sameSource =
    (prevClip.sourceId ?? null) === (nextClip.sourceId ?? null);
  const sourceChanged = !sameSource;

  // Time gap only meaningful within one source's timeline.
  const timeGapSeconds = sameSource
    ? round2(Math.max(0, nextClip.start - prevClip.end))
    : null;
  const temporallyAdjacent =
    sameSource &&
    timeGapSeconds !== null &&
    timeGapSeconds <= TIME_ADJACENCY_FALLBACK_SECONDS;

  if (sameSource) {
    evidence.push(`same source (gap ${timeGapSeconds ?? "?"}s)`);
  } else {
    evidence.push("different source");
  }

  const prevMotion = resolveSignal(prevClip.motion, context.getMotion, prevClip);
  const nextMotion = resolveSignal(nextClip.motion, context.getMotion, nextClip);
  const motionContrast =
    prevMotion !== null && nextMotion !== null
      ? round2(Math.abs(prevMotion - nextMotion))
      : null;
  if (prevMotion !== null || nextMotion !== null) {
    evidence.push(
      `motion ${fmtN(prevMotion)}→${fmtN(nextMotion)}${motionContrast !== null ? ` (Δ${motionContrast})` : ""}`
    );
  }

  const prevSaliency = resolveSignal(prevClip.saliency, context.getSaliency, prevClip);
  const nextSaliency = resolveSignal(nextClip.saliency, context.getSaliency, nextClip);
  const saliencyContrast =
    prevSaliency !== null && nextSaliency !== null
      ? round2(Math.abs(prevSaliency - nextSaliency))
      : null;
  if (saliencyContrast !== null) evidence.push(`saliency Δ${saliencyContrast}`);

  const prevText = safeText(context.getTranscriptText, prevClip);
  const nextText = safeText(context.getTranscriptText, nextClip);
  const transcriptOverlap =
    prevText && nextText ? jaccard(tokenize(prevText), tokenize(nextText)) : null;
  if (transcriptOverlap !== null) evidence.push(`transcript overlap ${transcriptOverlap}`);

  const prevTags = prevClip.label ? tokenize(prevClip.label) : [];
  const nextTags = nextClip.label ? tokenize(nextClip.label) : [];
  const tagOverlap = prevTags.length && nextTags.length ? jaccard(prevTags, nextTags) : null;
  if (tagOverlap !== null) evidence.push(`label overlap ${tagOverlap}`);

  const prevScene = safeId(context.getSceneId, prevClip);
  const nextScene = safeId(context.getSceneId, nextClip);
  const sameScene = prevScene && nextScene ? prevScene === nextScene : null;
  if (sameScene !== null) evidence.push(sameScene ? "same scene" : "scene changed");

  const prevChapter = safeId(context.getChapterId, prevClip);
  const nextChapter = safeId(context.getChapterId, nextClip);
  const sameChapter = prevChapter && nextChapter ? prevChapter === nextChapter : null;
  if (sameChapter !== null) evidence.push(sameChapter ? "same chapter" : "chapter changed");

  return {
    sameSource,
    sourceChanged,
    timeGapSeconds,
    temporallyAdjacent,
    prevMotion,
    nextMotion,
    motionContrast,
    prevSaliency,
    nextSaliency,
    saliencyContrast,
    transcriptOverlap,
    tagOverlap,
    sameScene,
    sameChapter,
    userPreferredSmooth: !!context.userPreferredSmooth,
    userPreferredFastCuts: !!context.userPreferredFastCuts,
    evidence
  };
}

/** Loose adjacency fallback used only inside features (the selector applies
 *  the configured `sameSourceAdjacentGapSeconds`). Kept slightly generous so
 *  features.temporallyAdjacent is informative even without config. */
const TIME_ADJACENCY_FALLBACK_SECONDS = 1.0;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function fmtN(n: number | null): string {
  return n === null ? "?" : String(round2(n));
}

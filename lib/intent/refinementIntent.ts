// =====================================================================
// lib/intent/refinementIntent.ts
//
// Detect TIMELINE-REFINEMENT turns — operate on the current edit, not a
// fresh visual search:
//   - remove content      ("remove cutscene", "remove all boring parts")
//   - keep only content    ("keep only fighting", "only combat")
//   - filter (both)        ("remove cutscene i need only fighting scene")
//   - trim to target        ("trim to fit")
//   - scope only            ("from current video clips", "use current timeline")
//
// It returns the include/exclude CONTENT phrases (preserved as phrases, not
// token soup) so the router can ask "re-pick keeping X, dropping Y?" and run
// a clean REPLACE — never a silent append search.
//
// It deliberately DEFERS (kind:"none") when the user references a specific
// clip by index ("remove clip 2", "this clip") — that is the deterministic
// clip-edit path's job, not a content filter.
//
// PURE: composes editingNormalize + topicPhrases + targetDurationMemory.
// NO genre/entity table. Unit-tested.
// =====================================================================

import { normalizeEditingText } from "./editingNormalize";
import { extractTopicPhrases } from "./topicPhrases";
import { isTrimToFitPhrase } from "./targetDurationMemory";

export type RefinementKind =
  | "remove"
  | "keep_only"
  | "filter"
  | "trim_to_target"
  | "scope_only"
  | "none";

export type RefineScope = "current_timeline" | "current_video";

export interface RefinementIntent {
  kind: RefinementKind;
  /** Content phrases to KEEP / feature. */
  include: string[];
  /** Content phrases to REMOVE / drop. */
  exclude: string[];
  /** Resolved source scope, when the turn names it. */
  scope?: RefineScope;
  confidence: number;
  /** The editing-normalized text the detection ran on (debug/reuse). */
  normalizedText: string;
}

// Marker → bucket. Order in the alternation matters (longer first).
const MARKER_RE =
  /\b(remove|delete|discard|drop|exclude|skip|cut out|take out|get rid of|rid of|without|don'?t want|don'?t need|do not want|do not need|no more|keep only|keep just|nothing but|focus on|keep|only|just)\b/gi;

const REMOVE_MARKERS = new Set([
  "remove", "delete", "discard", "drop", "exclude", "skip", "cut out",
  "take out", "get rid of", "rid of", "without", "dont want", "don't want",
  "dont need", "don't need", "do not want", "do not need", "no more"
]);

// Clip-INDEX references → defer to the deterministic clip-edit path.
const CLIP_REF_RE =
  /\b(?:clip|scene|part|segment|one)\s+(?:\d+|one|two|three|four|five|last|first)\b|\b(?:this|that|the last|the first|the selected|current)\s+(?:clip|one|scene|segment)\b|\bclip\s*#?\d+\b/i;

// Source-scope phrasing ("from current video clips", "use current timeline").
const CURRENT_TIMELINE_RE =
  /\b(current timeline|these clips|the current clips|from current clips|from the current clips|use (?:the )?current timeline|existing clips|clips i have|current edit)\b/i;
const CURRENT_VIDEO_RE =
  /\b(current video|this video|from current video|from the current video|current video'?s? clips|active video)\b/i;

function classifyMarker(marker: string): "remove" | "keep" {
  return REMOVE_MARKERS.has(marker.toLowerCase()) ? "remove" : "keep";
}

function detectScope(text: string): RefineScope | undefined {
  if (CURRENT_TIMELINE_RE.test(text)) return "current_timeline";
  if (CURRENT_VIDEO_RE.test(text)) return "current_video";
  return undefined;
}

/**
 * Classify a turn as a timeline refinement (or "none" to defer). The text is
 * editing-normalized first so typos ("cutsecene", "combact") don't hide the
 * content phrases.
 */
export function detectRefinement(text: string): RefinementIntent {
  const { normalized } = normalizeEditingText(text ?? "");
  const lower = normalized;
  const none = (): RefinementIntent => ({
    kind: "none",
    include: [],
    exclude: [],
    confidence: 0,
    normalizedText: lower
  });

  if (!lower) return none();

  // Describe / read-only / visual questions must NOT be caught as a scope
  // refinement just because they mention "this video". They belong on the
  // describe guard path, not the refine path.
  if (/\b(describe|what(?:'?s| is| are)?\s+(?:in|happening|going on)|what happens?|tell me about|summar(?:y|ize|ise)|analyse|analyze)\b/.test(lower)) {
    return none();
  }

  // Trim-to-target is its own (direct) operation.
  if (isTrimToFitPhrase(lower)) {
    return { kind: "trim_to_target", include: [], exclude: [], scope: detectScope(lower), confidence: 0.9, normalizedText: lower };
  }

  // Defer specific clip-index edits to the deterministic clip path.
  if (CLIP_REF_RE.test(lower)) return none();

  const scope = detectScope(lower);

  // Walk markers in order; the span after each marker (up to the next marker)
  // is that marker's content bucket.
  const markers: Array<{ type: "remove" | "keep"; start: number; end: number }> = [];
  MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(lower)) !== null) {
    markers.push({ type: classifyMarker(m[1]), start: m.index, end: m.index + m[0].length });
  }

  const include: string[] = [];
  const exclude: string[] = [];
  for (let i = 0; i < markers.length; i++) {
    const seg = lower.slice(markers[i].end, i + 1 < markers.length ? markers[i + 1].start : lower.length);
    const phrases = extractTopicPhrases(seg);
    if (phrases.length === 0) continue;
    if (markers[i].type === "remove") exclude.push(...phrases);
    else include.push(...phrases);
  }

  const dedupe = (xs: string[]) => Array.from(new Set(xs));
  const inc = dedupe(include);
  const exc = dedupe(exclude);

  // Scope-only answer ("from current video clips") with no markers/content.
  if (markers.length === 0 && inc.length === 0 && exc.length === 0) {
    if (scope) {
      return { kind: "scope_only", include: [], exclude: [], scope, confidence: 0.8, normalizedText: lower };
    }
    return none();
  }

  // A marker with no resolvable content and no scope → defer (ambiguous).
  if (inc.length === 0 && exc.length === 0 && !scope) return none();

  let kind: RefinementKind;
  if (inc.length > 0 && exc.length > 0) kind = "filter";
  else if (exc.length > 0) kind = "remove";
  else if (inc.length > 0) kind = "keep_only";
  else kind = "scope_only";

  return { kind, include: inc, exclude: exc, scope, confidence: 0.85, normalizedText: lower };
}

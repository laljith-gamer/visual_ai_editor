// =====================================================================
// lib/agentic-intake/editBrief.ts
//
// The EditBrief is the UNIVERSAL, stable internal representation of a
// user's editing intent. It is what the agentic intake layer builds
// (over one or more conversation turns) BEFORE anything is sent to a
// planner. It works for ANY video type and ANY editing goal — there is
// no genre table, no topic dictionary, no category-specific behaviour in
// here. Everything is generic editing vocabulary + the user's own words.
//
// Pipeline:
//   user message → inferBrief → (questionEngine) → promptCompiler →
//   localPlanner / cloud planner / deterministic path → render pipeline
//
// This module is PURE TypeScript: no React, no API calls, no store. It
// only defines the shape + small pure helpers (create / merge). Keeping
// it dependency-free makes it trivially unit-testable with `node --test`.
// =====================================================================

export const EDIT_BRIEF_VERSION = 1 as const;

/** What the user fundamentally wants to produce. Generic, not genre. */
export type IntentKind =
  | "create_short"
  | "highlight_reel"
  | "continuous_clip"
  | "specific_moment"
  | "extract_range"
  | "merge_sources"
  | "compose_montage"
  | "describe_video"
  | "style_existing_timeline"
  | "fix_existing_edit"
  | "export_render"
  | "unknown";

export type SourceScopeType =
  | "current"
  | "selected"
  | "all"
  | "explicit"
  | "unknown";

export type OutputFormat = "vertical" | "horizontal" | "square";

export type OutputPlatform =
  | "youtube_shorts"
  | "instagram_reels"
  | "tiktok"
  | "youtube"
  | "linkedin"
  | "generic";

export type OutputType = "single_continuous" | "multi_clip" | "as_is_merge";

export type Pacing = "slow" | "balanced" | "fast" | "unknown";

export type TranscriptNeed = "captions" | "quotes" | "none" | "unknown";

/** Visual effects a user might ASK for. Whether each is actually
 *  renderable is decided by the capability matrix — NOT here. */
export type VisualEffect =
  | "slow_zoom"
  | "speed_change"
  | "speed_ramp"
  | "color_grade"
  | "camera_shake"
  | "letterbox"
  | "text_overlay"
  | "captions"
  | "blur"
  | "crop_reframe";

export type AudioEffect =
  | "keep_original"
  | "lower_original"
  | "mute_original"
  | "bass_hit"
  | "whoosh"
  | "background_music"
  | "voiceover";

export interface TextOverlay {
  text: string;
  timing?: "start" | "middle" | "end" | "auto";
  priority?: number;
}

export interface SourceScope {
  type: SourceScopeType;
  sourceIds?: string[];
  reason?: string;
}

export interface BriefOutput {
  format?: OutputFormat;
  platform?: OutputPlatform;
  durationSeconds?: number;
  durationRange?: { min: number; max: number };
  outputType?: OutputType;
}

export interface BriefContent {
  focus?: string;
  momentDescription?: string;
  include?: string[];
  avoid?: string[];
  genericBestParts?: boolean;
  transcriptNeed?: TranscriptNeed;
}

export interface BriefStyle {
  mood?: string;
  pacing?: Pacing;
  visualTone?: string[];
  references?: string[];
}

export interface BriefEffects {
  requestedVisualEffects?: VisualEffect[];
  requestedAudioEffects?: AudioEffect[];
  textOverlays?: TextOverlay[];
}

export interface BriefConstraints {
  preserveOriginalAudio?: boolean;
  noExtraSources?: boolean;
  noTransitionsBetweenClips?: boolean;
  doNotAskForAnotherClip?: boolean;
  mustUseTimelineOnly?: boolean;
  userSaidContinuous?: boolean;
}

export interface BriefConfidence {
  intent: number;
  sourceScope: number;
  duration: number;
  format: number;
  style: number;
}

/** High-impact information still missing from the brief. The question
 *  engine reads this to decide whether to ask (and what). */
export type MissingField =
  | "source_scope"
  | "output_type"
  | "duration"
  | "format"
  | "content_focus"
  | "style"
  | "text"
  | "audio"
  | "avoid";

export interface EditBrief {
  version: typeof EDIT_BRIEF_VERSION;
  rawUserText: string;
  intentKind: IntentKind;
  sourceScope: SourceScope;
  output: BriefOutput;
  content: BriefContent;
  style: BriefStyle;
  effects: BriefEffects;
  constraints: BriefConstraints;
  confidence: BriefConfidence;
  missing: MissingField[];
}

// ---------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------

/** A fresh, empty brief — every slot unknown. */
export function createEmptyBrief(rawUserText = ""): EditBrief {
  return {
    version: EDIT_BRIEF_VERSION,
    rawUserText,
    intentKind: "unknown",
    sourceScope: { type: "unknown" },
    output: {},
    content: {},
    style: {},
    effects: {},
    constraints: {},
    confidence: {
      intent: 0,
      sourceScope: 0,
      duration: 0,
      format: 0,
      style: 0
    },
    missing: []
  };
}

/** Prefer `next` only when it is a meaningful (non-undefined) value. */
function coalesce<T>(next: T | undefined, prev: T | undefined): T | undefined {
  return next !== undefined && next !== null ? next : prev;
}

/** Union two optional string arrays, de-duplicated, order-stable. */
function unionArray<T>(a?: T[], b?: T[]): T[] | undefined {
  if (!a && !b) return undefined;
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of [...(a ?? []), ...(b ?? [])]) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.length > 0 ? out : undefined;
}

function maxConfidence(a: BriefConfidence, b: BriefConfidence): BriefConfidence {
  return {
    intent: Math.max(a.intent, b.intent),
    sourceScope: Math.max(a.sourceScope, b.sourceScope),
    duration: Math.max(a.duration, b.duration),
    format: Math.max(a.format, b.format),
    style: Math.max(a.style, b.style)
  };
}

/**
 * Merge a later-turn brief INTO an earlier one. Used to build a single
 * coherent brief across multiple conversation turns (e.g. the user says
 * "make this cool", then taps "Best-moments reel", then "30 seconds").
 *
 * Rule: the later turn refines but never erases earlier knowledge — a
 * known value only loses to another known value, never to "unknown".
 * Arrays (effects, overlays, include/avoid, tones) are unioned so each
 * turn can add detail. `missing` is intentionally NOT computed here; the
 * caller recomputes it against live context (see inferBrief.finalizeBrief).
 */
export function mergeBrief(prev: EditBrief, next: EditBrief): EditBrief {
  return {
    version: EDIT_BRIEF_VERSION,
    // Keep the latest raw text; the compiled prompt never echoes it anyway.
    rawUserText: next.rawUserText || prev.rawUserText,
    intentKind: next.intentKind !== "unknown" ? next.intentKind : prev.intentKind,
    sourceScope:
      next.sourceScope.type !== "unknown" ? next.sourceScope : prev.sourceScope,
    output: {
      format: coalesce(next.output.format, prev.output.format),
      platform: coalesce(next.output.platform, prev.output.platform),
      durationSeconds: coalesce(
        next.output.durationSeconds,
        prev.output.durationSeconds
      ),
      durationRange: coalesce(next.output.durationRange, prev.output.durationRange),
      outputType: coalesce(next.output.outputType, prev.output.outputType)
    },
    content: {
      focus: coalesce(next.content.focus, prev.content.focus),
      momentDescription: coalesce(
        next.content.momentDescription,
        prev.content.momentDescription
      ),
      include: unionArray(prev.content.include, next.content.include),
      avoid: unionArray(prev.content.avoid, next.content.avoid),
      genericBestParts:
        next.content.genericBestParts || prev.content.genericBestParts || undefined,
      transcriptNeed:
        next.content.transcriptNeed && next.content.transcriptNeed !== "unknown"
          ? next.content.transcriptNeed
          : prev.content.transcriptNeed
    },
    style: {
      mood: coalesce(next.style.mood, prev.style.mood),
      pacing:
        next.style.pacing && next.style.pacing !== "unknown"
          ? next.style.pacing
          : prev.style.pacing,
      visualTone: unionArray(prev.style.visualTone, next.style.visualTone),
      references: unionArray(prev.style.references, next.style.references)
    },
    effects: {
      requestedVisualEffects: unionArray(
        prev.effects.requestedVisualEffects,
        next.effects.requestedVisualEffects
      ),
      requestedAudioEffects: unionArray(
        prev.effects.requestedAudioEffects,
        next.effects.requestedAudioEffects
      ),
      textOverlays: unionArray(
        prev.effects.textOverlays,
        next.effects.textOverlays
      )
    },
    constraints: {
      preserveOriginalAudio:
        next.constraints.preserveOriginalAudio ??
        prev.constraints.preserveOriginalAudio,
      noExtraSources:
        next.constraints.noExtraSources ?? prev.constraints.noExtraSources,
      noTransitionsBetweenClips:
        next.constraints.noTransitionsBetweenClips ??
        prev.constraints.noTransitionsBetweenClips,
      doNotAskForAnotherClip:
        next.constraints.doNotAskForAnotherClip ??
        prev.constraints.doNotAskForAnotherClip,
      mustUseTimelineOnly:
        next.constraints.mustUseTimelineOnly ??
        prev.constraints.mustUseTimelineOnly,
      userSaidContinuous:
        next.constraints.userSaidContinuous ?? prev.constraints.userSaidContinuous
    },
    confidence: maxConfidence(prev.confidence, next.confidence),
    missing: next.missing
  };
}

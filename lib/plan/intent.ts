import type {
  ChatMessage,
  EditPlan,
  IntentMode,
  SessionMemory
} from "@/lib/types";
import { INFERENCE_HEURISTICS } from "@/lib/config";

/**
 * Pre-LLM intent inference. Looks at the user's latest message + context
 * and produces a hint that the planner uses to bias its mode/format/duration
 * choices. The LLM still decides — this is just guidance baked into the
 * prompt + a fallback for when the LLM is uncertain.
 *
 * Policy: see .kiro/steering/conversation-patterns.md.
 */

export interface IntentHint {
  /** What the heuristics think the mode is. The LLM can override. */
  likelyMode: IntentMode | "unknown";
  /** True when the user's message looks like a refinement of an existing plan. */
  isRefinement: boolean;
  /** Inferred from source aspect ratio and prompt keywords. */
  inferredFormat?: EditPlan["format"];
  /** Inferred from source duration when user didn't say. */
  inferredTargetSeconds?: number;
  /** Pacing class for sample-every / max-clip overrides. */
  inferredPacing?: "sports" | "talking" | "default";
  /** Did the user state a duration explicitly in this turn? */
  userStatedDuration?: number;
  /** Did the user state a format explicitly in this turn? */
  userStatedFormat?: EditPlan["format"];
  /** Heuristic signals that fired (debug visibility in agent response). */
  signals: string[];
}

/** Phrases that explicitly request a fresh start. */
const RESET_PHRASES = [
  /\b(start over|restart|reset|new (?:chat|edit)|forget (?:that|everything))\b/i
];

/** Short imperatives that look like refinements ("make it shorter", "vertical please"). */
const REFINEMENT_PHRASES = [
  /\b(make it (longer|shorter|wider|narrower|punchier|slower|faster))\b/i,
  /\b(actually|wait|change|swap|update|tweak|nudge|extend|shorten|trim)\b/i,
  /\b(now (also|add|remove|drop)|add the|remove the|drop the)\b/i,
  /\b(go (vertical|horizontal|square))\b/i,
  /\b(use (fade|crossfade|no transition))\b/i
];

/** Phrases that mark a single-moment query. */
const MOMENT_PHRASES = [
  /\b(find|show me|jump to|where|the part where|the moment|the bit where|the scene)\b/i,
  /\b(at \d+:\d+|at \d+ ?(minute|second)s?)\b/i
];

/** Heuristic for "user gave us nothing actionable". */
const VAGUE_PHRASES = [
  /^(make me a (short|clip|video))\.?$/i,
  /^(best (clip|moment|moments|short))s?\.?$/i,
  /^(highlights?)\.?$/i,
  /^(hi|hey|hello|sup)\.?$/i
];

/** Extract a duration mentioned by the user, in seconds. */
export function extractDurationSeconds(text: string): number | undefined {
  // 30 sec / 30 seconds / 30s
  let m = text.match(/(\d+(?:\.\d+)?)\s*(s\b|sec(?:ond)?s?)/i);
  if (m) return parseFloat(m[1]);
  // 1 min / 1 minute / 2.5 minutes
  m = text.match(/(\d+(?:\.\d+)?)\s*min(?:ute)?s?\b/i);
  if (m) return parseFloat(m[1]) * 60;
  // 1m20s
  m = text.match(/(\d+)m\s*(\d+)s/i);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return undefined;
}

/** Pull a format hint from explicit phrasing or platform mention. */
export function extractFormat(text: string): EditPlan["format"] | undefined {
  const lower = text.toLowerCase();
  if (/\b(vertical|portrait|9 ?[:x] ?16)\b/.test(lower)) return "vertical";
  if (/\b(horizontal|landscape|16 ?[:x] ?9|widescreen)\b/.test(lower)) return "horizontal";
  if (/\b(square|1 ?[:x] ?1)\b/.test(lower)) return "square";
  for (const kw of INFERENCE_HEURISTICS.keywords.vertical) {
    if (lower.includes(kw)) return "vertical";
  }
  for (const kw of INFERENCE_HEURISTICS.keywords.horizontal) {
    if (lower.includes(kw)) return "horizontal";
  }
  for (const kw of INFERENCE_HEURISTICS.keywords.square) {
    if (lower.includes(kw)) return "square";
  }
  return undefined;
}

/** Format inferred from source aspect ratio when the prompt didn't say. */
export function inferFormatFromSource(width: number, height: number): EditPlan["format"] | undefined {
  if (!width || !height) return undefined;
  const ratio = width / height;
  if (ratio < INFERENCE_HEURISTICS.portraitAspectMax) return "vertical";
  if (ratio > INFERENCE_HEURISTICS.landscapeAspectMin) return "horizontal";
  return "square";
}

/** Target-duration heuristic from source length when user didn't say. */
export function inferTargetSecondsFromSource(sourceDuration: number): number {
  const h = INFERENCE_HEURISTICS;
  if (sourceDuration <= h.sourceLength.veryShortMaxSeconds) {
    const candidate = sourceDuration * h.inferredTarget.veryShortFractionOfSource;
    return Math.min(candidate, h.inferredTarget.veryShortHardCap);
  }
  if (sourceDuration <= h.sourceLength.shortMaxSeconds) {
    return h.inferredTarget.short;
  }
  if (sourceDuration >= h.sourceLength.longMinSeconds) {
    return h.inferredTarget.long;
  }
  return h.inferredTarget.medium;
}

/** Pacing class from prompt keywords. */
export function inferPacing(text: string): "sports" | "talking" | "default" {
  const lower = text.toLowerCase();
  for (const kw of INFERENCE_HEURISTICS.keywords.sports) {
    if (lower.includes(kw)) return "sports";
  }
  for (const kw of INFERENCE_HEURISTICS.keywords.talking) {
    if (lower.includes(kw)) return "talking";
  }
  return "default";
}

/** Aggregated entry point. */
export function inferIntent(args: {
  userMessage: string;
  conversationHistory: ChatMessage[];
  currentPlan: EditPlan | null;
  videoMeta?: { duration: number; width: number; height: number };
  memory: SessionMemory;
}): IntentHint {
  const { userMessage, currentPlan, videoMeta, memory } = args;
  const signals: string[] = [];
  const text = userMessage.trim();
  const lower = text.toLowerCase();

  // Refinement detection.
  const isReset = RESET_PHRASES.some((re) => re.test(text));
  const isRefinement =
    !isReset && currentPlan != null && REFINEMENT_PHRASES.some((re) => re.test(text));
  if (isReset) signals.push("reset_phrase");
  if (isRefinement) signals.push("refinement_phrase");

  // Mode classification.
  let likelyMode: IntentMode | "unknown" = "unknown";
  if (MOMENT_PHRASES.some((re) => re.test(text))) {
    likelyMode = "moment";
    signals.push("moment_phrase");
  } else if (VAGUE_PHRASES.some((re) => re.test(text)) && !isRefinement) {
    likelyMode = "clarify";
    signals.push("vague_phrase");
  } else if (text.length > 12 || isRefinement) {
    likelyMode = "plan";
  }

  // Duration: user-stated > memory > inferred from source.
  const userStatedDuration = extractDurationSeconds(text);
  let inferredTargetSeconds: number | undefined;
  if (userStatedDuration != null) {
    signals.push("user_stated_duration");
  } else if (memory.duration != null) {
    inferredTargetSeconds = memory.duration;
    signals.push("memory_duration");
  } else if (videoMeta) {
    inferredTargetSeconds = inferTargetSecondsFromSource(videoMeta.duration);
    signals.push("source_duration_heuristic");
  }

  // Format: user-stated > memory > inferred from source aspect.
  const userStatedFormat = extractFormat(text);
  let inferredFormat: EditPlan["format"] | undefined;
  if (userStatedFormat != null) {
    signals.push("user_stated_format");
  } else if (memory.format != null) {
    inferredFormat = memory.format;
    signals.push("memory_format");
  } else if (videoMeta) {
    inferredFormat = inferFormatFromSource(videoMeta.width, videoMeta.height);
    if (inferredFormat) signals.push("source_aspect_heuristic");
  }

  // Pacing.
  const inferredPacing = inferPacing(lower);
  if (inferredPacing !== "default") signals.push(`pacing_${inferredPacing}`);

  // Demote to clarify if we still have nothing actionable.
  if (likelyMode === "unknown" && !isRefinement) {
    if (!userStatedDuration && memory.duration == null && !videoMeta) {
      likelyMode = "clarify";
      signals.push("no_actionable_signal");
    } else {
      likelyMode = "plan";
    }
  }

  return {
    likelyMode,
    isRefinement,
    inferredFormat,
    inferredTargetSeconds,
    inferredPacing,
    userStatedDuration,
    userStatedFormat,
    signals
  };
}

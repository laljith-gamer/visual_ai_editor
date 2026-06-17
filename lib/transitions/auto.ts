/**
 * PR 59 — deterministic auto-transition selector.
 *
 * Chooses a transition for ONE boundary from GENERIC media signals only
 * (lib/transitions/features.ts). There is deliberately NO genre/keyword
 * table — the decision uses source continuity, time gap, motion/saliency
 * level + contrast, transcript/tag overlap, scene/chapter continuity, and
 * explicit user preference. All thresholds come from
 * `TRANSITIONS.autoPick` in lib/config.ts.
 *
 * Output is a full `BoundaryTransition` (mode "auto") with a human reason,
 * evidence, confidence, AND the honestly-mapped renderable transition
 * (`render`/`exact`/`note` via `mapTransition`) so the UI/render never
 * claims an effect the worker can't produce.
 *
 * Pure (imports config constants + pure helpers) → unit-testable.
 */

import { TRANSITIONS } from "../config";
import { buildTransitionFeatures, type TransitionClip, type TransitionContext } from "./features";
import { mapTransition } from "./map";
import { normalizeTransitionDuration, type BoundaryTransition, type TransitionType } from "./types";

const A = TRANSITIONS.autoPick;

interface Decision {
  type: TransitionType;
  reason: string;
  confidence: number;
}

export interface SelectAutoOptions {
  /** Boundary index to stamp on the result (default 0). */
  index?: number;
  /** Optional explicit duration; defaulted/clamped otherwise. */
  durationSeconds?: number;
}

export function selectAutoTransition(
  prevClip: TransitionClip,
  nextClip: TransitionClip,
  context: TransitionContext = {},
  options: SelectAutoOptions = {}
): BoundaryTransition {
  const f = buildTransitionFeatures(prevClip, nextClip, context);
  const decision = decide(f);

  const mapped = mapTransition(decision.type);
  const result: BoundaryTransition = {
    index: options.index ?? 0,
    type: decision.type,
    durationSeconds: normalizeTransitionDuration(options.durationSeconds),
    mode: "auto",
    confidence: round2(decision.confidence),
    reason: decision.reason,
    evidence: f.evidence,
    render: mapped.render,
    exact: mapped.exact
  };
  if (mapped.note) result.note = mapped.note;
  return result;
}

/** The pure decision tree. Precedence is fixed + documented so it stays
 *  deterministic and testable. */
function decide(f: ReturnType<typeof buildTransitionFeatures>): Decision {
  const highMotion =
    (f.prevMotion !== null && f.prevMotion >= A.highMotionFloor) ||
    (f.nextMotion !== null && f.nextMotion >= A.highMotionFloor);
  const lowMotionBoth =
    f.prevMotion !== null &&
    f.nextMotion !== null &&
    f.prevMotion <= A.lowMotionCeiling &&
    f.nextMotion <= A.lowMotionCeiling;
  const strongContrast =
    (f.motionContrast !== null && f.motionContrast >= A.strongContrastFloor) ||
    (f.saliencyContrast !== null && f.saliencyContrast >= A.strongContrastFloor);
  const relatedTopic =
    (f.transcriptOverlap !== null && f.transcriptOverlap >= A.relatedTopicFloor) ||
    (f.tagOverlap !== null && f.tagOverlap >= A.relatedTopicFloor) ||
    f.sameScene === true;
  const adjacent =
    f.sameSource &&
    f.timeGapSeconds !== null &&
    f.timeGapSeconds <= A.sameSourceAdjacentGapSeconds;

  // 1. Explicit user "fast/punchy" preference → hard cut.
  if (f.userPreferredFastCuts) {
    return { type: "cut", reason: "you asked for fast, punchy cuts", confidence: 0.8 };
  }

  // 2. High motion on either side → cut keeps the energy.
  if (highMotion) {
    return { type: "cut", reason: "high motion keeps energy better with a cut", confidence: 0.8 };
  }

  // 3. Explicit user "smooth/cinematic" preference → smoother family
  //    (fade when there's a strong jump to absorb, else crossfade).
  if (f.userPreferredSmooth) {
    return strongContrast
      ? { type: "fade", reason: "you asked for smoother transitions; large contrast → fade", confidence: 0.7 }
      : { type: "crossfade", reason: "you asked for smoother transitions", confidence: 0.7 };
  }

  // 4. Strong visual/audio contrast → fade absorbs the jump.
  if (strongContrast) {
    return { type: "fade", reason: "large visual/audio contrast", confidence: A.defaultConfidence };
  }

  // 5. Calm, low-motion clips → smoother crossfade.
  if (lowMotionBoth) {
    return { type: "crossfade", reason: "low-motion clips benefit from a smoother transition", confidence: A.defaultConfidence };
  }

  // 6. Different sources → crossfade when related, fade on a topic change.
  if (f.sourceChanged) {
    return relatedTopic
      ? { type: "crossfade", reason: "different source but related content", confidence: A.defaultConfidence }
      : { type: "fade", reason: "scene/topic changed", confidence: A.defaultConfidence };
  }

  // 7. Same source, temporally adjacent, no strong jump → clean hard cut.
  if (adjacent) {
    return { type: "cut", reason: "same source and adjacent time", confidence: 0.75 };
  }

  // 8. Same source but a noticeable time jump → fade.
  if (f.sameSource && !adjacent) {
    return { type: "fade", reason: "same source but a time jump", confidence: 0.55 };
  }

  // 9. Nothing decisive → a clean cut is the safe default.
  return { type: "cut", reason: "default clean cut", confidence: 0.5 };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

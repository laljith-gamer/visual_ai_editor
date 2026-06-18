// =====================================================================
// lib/pipeline/coverage.ts — target-coverage assessment (issue #62).
//
// Decides whether a finished selection may honestly be marked "ready to
// render" or whether the user must be asked first. The rule: when the user
// stated an explicit duration, a result that falls materially short of it —
// especially with weak/low confidence — must NOT be silently shipped as
// "ready to render / Tap Render". Instead we surface an honest message and
// offer a broader fallback.
//
// Pure (config constants via a relative import) → unit-testable with
// `node --test --experimental-strip-types`.
// =====================================================================

import { TARGET_COVERAGE } from "../config";

export interface CoverageArgs {
  /** Did the user explicitly state a target duration this run? */
  userSpecifiedDuration: boolean;
  /** The requested target duration in seconds. */
  targetSeconds: number;
  /** Total seconds actually selected onto the timeline. */
  selectedSeconds: number;
  /** Number of clips selected. */
  clipCount: number;
  /** True when the only matches were below the strong-confidence threshold. */
  weakOnly: boolean;
  /** Max composite/frame score seen (0..1) — used for the honest copy. */
  scoreMax: number;
}

export interface CoverageAssessment {
  /** "ok" → may be marked ready to render. "review" → ask the user first. */
  level: "ok" | "review";
  /** selectedSeconds / targetSeconds (1 when no explicit target). */
  ratio: number;
  /** When "review", an honest message that does NOT say "Tap Render". */
  message?: string;
  /** Short status-pill detail for the "review" state. */
  statusDetail?: string;
}

/**
 * Assess whether the selection acceptably covers an explicitly-requested
 * duration. With no explicit duration the result is always "ok" (the
 * quality-floor path owns emergent length — issue #62 must not change that).
 */
export function assessTargetCoverage(args: CoverageArgs): CoverageAssessment {
  const { userSpecifiedDuration, targetSeconds, selectedSeconds, weakOnly } = args;

  if (!userSpecifiedDuration || targetSeconds <= 0) {
    return { level: "ok", ratio: 1 };
  }

  const ratio = selectedSeconds / targetSeconds;
  const hardUnderfill = ratio < TARGET_COVERAGE.hardUnderfillFraction;
  const weakUnderfill = weakOnly && ratio < TARGET_COVERAGE.weakConfidenceAskFraction;

  if (hardUnderfill || weakUnderfill) {
    return {
      level: "review",
      ratio,
      message: buildUnderfillMessage(args),
      statusDetail: `Only ${round1(selectedSeconds)}s of ${round1(targetSeconds)}s — needs review`
    };
  }

  return { level: "ok", ratio };
}

/**
 * Build the honest underfill message. It states exactly how much was found,
 * the target, and offers a broader-fallback option or a more specific focus.
 * Deliberately never contains "Tap Render" / "ready to render".
 */
export function buildUnderfillMessage(args: CoverageArgs): string {
  const found = round1(args.selectedSeconds);
  const target = round1(args.targetSeconds);
  const lead =
    args.clipCount === 0
      ? `I couldn't confidently find material for your ${target}s request.`
      : `I only found ${found}s with strong enough evidence for your ${target}s target.`;
  return (
    `${lead} I can broaden the search and build a fuller ${target}s reel using ` +
    `lower-confidence visual-interest moments, or you can give me a more ` +
    `specific focus. Want me to make the broader ${target}s reel?`
  );
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

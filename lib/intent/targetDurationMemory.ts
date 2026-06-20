// =====================================================================
// lib/intent/targetDurationMemory.ts
//
// "Latest explicit duration wins." A user can change their mind across turns
// ("...for 2 min" then later "make video for 1 min"); the ACTIVE target must
// follow the most recent explicit duration, not the stale plan duration.
//
// These are PURE helpers; the store holds the actual `activeTargetSeconds`
// and updates it via `resolveActiveTarget` on every turn that states one.
// Duration parsing is delegated to the existing professional interpreter so
// there is ONE parser. PURE: unit-tested.
// =====================================================================

import { parseDuration } from "./videoPromptInterpreter";

export interface ActiveTargetResult {
  /** The active target after this turn (null when never stated). */
  seconds: number | null;
  /** True when THIS turn stated an explicit duration (the target changed
   *  to it, even if the value equals the prior). */
  changed: boolean;
}

/**
 * Resolve the active target duration given the prior active target and the
 * current turn's text. The latest explicitly-stated duration always wins;
 * when the turn states none, the prior target is preserved.
 */
export function resolveActiveTarget(prior: number | null, text: string): ActiveTargetResult {
  const parsed = parseDuration(text);
  if (parsed !== null) return { seconds: parsed, changed: true };
  return { seconds: prior ?? null, changed: false };
}

const TRIM_TO_FIT_RE =
  /\b(trim to fit|fit (?:the )?(?:target|duration|time)|cut to (?:fit|length)|trim to (?:length|time|target)|make it fit|shorten to fit|trim it down to fit)\b/i;

const MAKE_IT_DURATION_RE =
  /\b(make it|keep it|trim to|cut to|shorten to|limit to|cap at|under)\s+(?:\d+(?:\.\d+)?\s*(?:s|sec|secs|seconds|m|min|mins|minute|minutes)|\d{1,2}:\d{2})\b/i;

/** True when the turn is a "trim to fit / fit the target" instruction. */
export function isTrimToFitPhrase(text: string): boolean {
  return TRIM_TO_FIT_RE.test(text ?? "");
}

/**
 * True when the turn is essentially a DURATION-ONLY instruction (a bare
 * duration or "make it 1 min"), with no content topic. The caller pairs this
 * with a topic check to decide between "trim the existing edit to the new
 * target" and "a new creation request".
 */
export function isDurationOnlyInstruction(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (isTrimToFitPhrase(t)) return true;
  if (MAKE_IT_DURATION_RE.test(t)) return true;
  // A very short utterance that is essentially just a duration ("1 min",
  // "30 seconds", "1:30").
  const stripped = t
    .toLowerCase()
    .replace(/\b(make it|keep it|just|please|now|to|about|around)\b/g, "")
    .replace(/[^a-z0-9:.\s]/g, "")
    .trim();
  const bareDuration =
    /^(?:\d+(?:\.\d+)?\s*(?:s|sec|secs|seconds|m|min|mins|minute|minutes)|\d{1,2}:\d{2})$/.test(
      stripped
    );
  return bareDuration;
}

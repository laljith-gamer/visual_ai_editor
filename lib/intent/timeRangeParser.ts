/**
 * Phase 1 — time-range parsing for the agentic command layer.
 *
 * Produces UNRESOLVED `TimeRangeSpec`s first (intent only), then a
 * separate `resolveTimeRange` converts a spec into concrete
 * `{ start, end }` seconds using the source duration (and, for relative
 * phrasings, an anchor clip's bounds). Keeping the two steps apart makes
 * the parser pure and unit-testable without a live video.
 *
 * Reuses the existing low-level helpers in `./time.ts` (parseTimestamp,
 * parseNumber) rather than duplicating timestamp logic.
 *
 * Supported phrasings (see tests for the canonical list):
 *   first 2 min · first 30 sec · last 1 min · last 30 seconds ·
 *   middle 30 sec · first half · second half · the middle part ·
 *   from 1:20 to 2:10 · 0:30-0:45 · before 1:00 · after 2:00 ·
 *   10 seconds before clip 2 · 5 seconds after that
 */

import type { ClipRef, TimeRangeSpec } from "./command";
import { parseNumber, parseTimestamp } from "./time";
import { parseClipRef } from "./clipResolver";

function unitFactor(unit: string): number {
  const u = unit.toLowerCase();
  if (/^seconds?$|^secs?$|^s$/.test(u)) return 1;
  if (/^minutes?$|^mins?$|^m$/.test(u)) return 60;
  if (/^hours?$|^hrs?$|^h$/.test(u)) return 3600;
  return 1;
}

const AMOUNT_RE =
  /(\d+(?:\.\d+)?|[a-z]+(?:[\s-][a-z]+){0,2})\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|\bm\b|\bs\b|\bh\b)/;

/** Parse the amount+unit fragment at the START of `frag` → seconds. */
function parseAmountSeconds(frag: string): number | null {
  const m = frag.match(AMOUNT_RE);
  if (!m) return null;
  const n = parseNumber(m[1]);
  if (n == null) return null;
  const secs = n * unitFactor(m[2]);
  return secs > 0 ? secs : null;
}

/**
 * Parse a time-range expression into an unresolved spec, or null.
 *
 * NOTE: order matters — relative-to-clip and absolute ranges are tried
 * before the bare "first/last N" forms so "10 seconds before clip 2"
 * isn't mis-read as "first/last 10 seconds".
 */
export function parseTimeRangeSpec(text: string): TimeRangeSpec | null {
  if (!text) return null;
  const lower = text.toLowerCase();

  // 1. Relative to a clip: "10 seconds before clip 2" / "5 sec after that".
  {
    const m = lower.match(
      /(\d+(?:\.\d+)?|[a-z]+(?:[\s-][a-z]+){0,2})\s*(seconds?|secs?|minutes?|mins?|s|m)\s+(before|after)\s+(.+)$/
    );
    if (m) {
      const n = parseNumber(m[1]);
      const anchor = parseClipRef(m[4]);
      if (n != null && anchor) {
        return {
          kind: "relative_to_clip",
          anchor,
          direction: m[3] === "before" ? "before" : "after",
          seconds: n * unitFactor(m[2]),
          spoken: m[0].trim()
        };
      }
    }
  }

  // 2. Absolute range: "from 1:20 to 2:10", "0:30-0:45", "between 0:30 and 1:00".
  {
    const m = lower.match(
      /(?:from|between)?\s*(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)\s*(?:to|-|–|and|until)\s*(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)/
    );
    if (m) {
      const start = parseTimestamp(m[1]);
      const end = parseTimestamp(m[2]);
      if (start != null && end != null && end > start) {
        return { kind: "absolute", startSeconds: start, endSeconds: end, spoken: m[0].trim() };
      }
    }
  }

  // 3. "first half" / "second half" / "the middle part".
  if (/\bfirst\s+half\b/.test(lower)) return { kind: "first_half", spoken: "first half" };
  if (/\b(?:second|last|other)\s+half\b/.test(lower))
    return { kind: "second_half", spoken: "second half" };
  if (/\b(?:the\s+)?middle\s+(?:part|section|portion|bit)\b/.test(lower))
    return { kind: "middle_fraction", spoken: "the middle part" };

  // 4. "middle N <unit>".
  {
    const m = lower.match(/\bmiddle\s+(.+)$/);
    if (m) {
      const secs = parseAmountSeconds(m[1]);
      if (secs != null) return { kind: "middle_amount", seconds: secs, spoken: `middle ${m[1].trim()}` };
    }
  }

  // 5. "first N <unit>" / "first minute".
  {
    const m = lower.match(/\bfirst\s+(.+)$/);
    if (m) {
      const secs = parseAmountSeconds(m[1]);
      if (secs != null) return { kind: "first_amount", seconds: secs, spoken: `first ${m[1].trim()}` };
      if (/^minute\b/.test(m[1].trim())) return { kind: "first_amount", seconds: 60, spoken: "first minute" };
      if (/^second\b/.test(m[1].trim())) return { kind: "first_amount", seconds: 1, spoken: "first second" };
    }
  }

  // 6. "last N <unit>" / "last minute".
  {
    const m = lower.match(/\blast\s+(.+)$/);
    if (m) {
      const secs = parseAmountSeconds(m[1]);
      if (secs != null) return { kind: "last_amount", seconds: secs, spoken: `last ${m[1].trim()}` };
      if (/^minute\b/.test(m[1].trim())) return { kind: "last_amount", seconds: 60, spoken: "last minute" };
      if (/^second\b/.test(m[1].trim())) return { kind: "last_amount", seconds: 1, spoken: "last second" };
    }
  }

  // 7. "before 1:00" / "before 30 seconds".
  {
    const m = lower.match(/\bbefore\s+(\d{1,2}:\d{2}(?:[.:]\d{1,3})?|\S.+)$/);
    if (m) {
      const t = parseTimestamp(m[1]) ?? parseAmountSeconds(m[1]);
      if (t != null && t > 0) return { kind: "before_time", seconds: t, spoken: m[0].trim() };
    }
  }

  // 8. "after 2:00" / "after 90 seconds".
  {
    const m = lower.match(/\bafter\s+(\d{1,2}:\d{2}(?:[.:]\d{1,3})?|\S.+)$/);
    if (m) {
      const t = parseTimestamp(m[1]) ?? parseAmountSeconds(m[1]);
      if (t != null && t >= 0) return { kind: "after_time", seconds: t, spoken: m[0].trim() };
    }
  }

  return null;
}

/** Concrete bounds resolved from a spec. */
export interface ResolvedRange {
  start: number;
  end: number;
  /** Whether the user gave an EXACT window (absolute / relative). Exact
   *  ranges must never be dropped by overlap/cap logic downstream. */
  exact: boolean;
}

export interface ResolveTimeRangeArgs {
  spec: TimeRangeSpec;
  /** Duration of the resolved source video, in seconds. */
  durationSeconds: number;
  /** For relative_to_clip specs: the anchor clip's bounds. */
  anchorClip?: { start: number; end: number } | null;
}

function clampRange(start: number, end: number, dur: number): ResolvedRange | null {
  const s = Math.max(0, Math.min(start, dur));
  const e = Math.max(0, Math.min(end, dur));
  if (e - s < 0.1) return null;
  return { start: round2(s), end: round2(e), exact: false };
}

/**
 * Resolve an unresolved range spec into concrete seconds against the
 * source duration. Returns null when the spec can't fit the video.
 */
export function resolveTimeRange(args: ResolveTimeRangeArgs): ResolvedRange | null {
  const { spec, durationSeconds: dur } = args;
  if (dur <= 0) return null;

  switch (spec.kind) {
    case "first_amount":
      return clampRange(0, spec.seconds, dur);
    case "last_amount":
      return clampRange(dur - spec.seconds, dur, dur);
    case "middle_amount": {
      const half = spec.seconds / 2;
      const mid = dur / 2;
      return clampRange(mid - half, mid + half, dur);
    }
    case "first_half":
      return clampRange(0, dur / 2, dur);
    case "second_half":
      return clampRange(dur / 2, dur, dur);
    case "middle_fraction":
      // The middle third — a reasonable interpretation of "the middle part".
      return clampRange(dur / 3, (dur * 2) / 3, dur);
    case "before_time":
      return clampRange(0, spec.seconds, dur);
    case "after_time":
      return clampRange(spec.seconds, dur, dur);
    case "absolute": {
      const r = clampRange(spec.startSeconds, spec.endSeconds, dur);
      return r ? { ...r, exact: true } : null;
    }
    case "relative_to_clip": {
      if (!args.anchorClip) return null;
      const a = args.anchorClip;
      let start: number;
      let end: number;
      if (spec.direction === "before") {
        end = a.start;
        start = a.start - spec.seconds;
      } else {
        start = a.end;
        end = a.end + spec.seconds;
      }
      const r = clampRange(start, end, dur);
      return r ? { ...r, exact: true } : null;
    }
    default:
      return null;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

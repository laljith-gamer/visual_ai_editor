/**
 * v1.7.5 — Duration + range parsing for intent slots.
 *
 * Custom rather than using chrono-node directly because:
 *   - chrono-node is built for absolute dates ("next Tuesday at 3pm"),
 *     not video-editing durations ("first 30 seconds", "0:30 to 1:45").
 *   - Adding chrono-node anyway gives us an extra ~200KB for ~10% of
 *     real-world phrasings; not worth it for v1.
 *
 * If the user's phrasings expand beyond what these regexes catch,
 * adding chrono-node behind a `tryChrono()` fallback is straightforward.
 *
 * All functions here return `null` on no match; callers fall through
 * to the cloud planner on null results.
 */

import { NUMBER_WORDS } from "./dictionary";

export interface ParsedRange {
  kind: "first" | "last" | "absolute";
  startSeconds: number;
  endSeconds: number;
  /** Verbatim phrase that produced the match, for the `spoken` field. */
  spoken: string;
}

/** Parse a time RANGE expression. Returns the FIRST matched range
 *  (the earliest one in the string) so multi-range inputs like
 *  "first 30s and last 30s" prefer the first half — the user can
 *  refine on the next turn. */
export function parseRange(text: string): ParsedRange | null {
  if (!text) return null;
  const lower = text.toLowerCase();

  // 1. "first N <unit>" — produces a (kind: "first") range.
  //    Handles "first 30 seconds" / "first thirty seconds" / "first 1:30" /
  //    "first minute" (defaults N=1 when no number).
  {
    const m = lower.match(
      /first\s+(?:(\d+(?:\.\d+)?|[a-z]+(?:[\s-][a-z]+){0,2})\s+)?(seconds?|secs?|minutes?|mins?|hours?|hrs?|m|s|h)\b/
    );
    if (m) {
      // When the explicit number is omitted ("first minute"), default to 1.
      const n = m[1] != null ? parseNumber(m[1]) : 1;
      const unit = m[2];
      if (n != null) {
        const seconds = toSeconds(n, unit);
        if (seconds > 0) {
          return {
            kind: "first",
            startSeconds: 0,
            endSeconds: seconds,
            spoken: m[0]
          };
        }
      }
    }
  }

  // 2. "last N <unit>"
  {
    const m = lower.match(
      /last\s+(?:(\d+(?:\.\d+)?|[a-z]+(?:[\s-][a-z]+){0,2})\s+)?(seconds?|secs?|minutes?|mins?|hours?|hrs?|m|s|h)\b/
    );
    if (m) {
      const n = m[1] != null ? parseNumber(m[1]) : 1;
      const unit = m[2];
      if (n != null) {
        const seconds = toSeconds(n, unit);
        if (seconds > 0) {
          return {
            kind: "last",
            // Server interprets via duration; we just carry the LENGTH.
            startSeconds: 0,
            endSeconds: seconds,
            spoken: m[0]
          };
        }
      }
    }
  }

  // 3. "from M:SS to M:SS" / "M:SS to M:SS" / "between M:SS and M:SS"
  {
    const m = lower.match(
      /(?:from|between)?\s*(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)\s*(?:to|-|–|and)\s*(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)/
    );
    if (m) {
      const start = parseTimestamp(m[1]);
      const end = parseTimestamp(m[2]);
      if (start != null && end != null && end > start) {
        return {
          kind: "absolute",
          startSeconds: start,
          endSeconds: end,
          spoken: m[0].trim()
        };
      }
    }
  }

  return null;
}

/** Parse a single duration (no range). Returns just the seconds count.
 *  Handles "30 seconds", "thirty seconds", "1 minute", "minute and a
 *  half", "1m30s". Returns null on no match. */
export function parseDuration(text: string): number | null {
  if (!text) return null;
  const lower = text.toLowerCase().trim();

  // "1m30s" / "2m" / "45s" — compact form
  {
    const m = lower.match(/^(\d+)\s*m\s*(\d+)\s*s$/);
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }
  {
    const m = lower.match(/^(\d+)\s*m$/);
    if (m) return parseInt(m[1], 10) * 60;
  }
  {
    const m = lower.match(/^(\d+)\s*s$/);
    if (m) return parseInt(m[1], 10);
  }

  // "minute and a half" / "an hour and a half" / "a minute and a half"
  {
    const m = lower.match(
      /(?:an?\s+)?(\w+)\s+and\s+a\s+half/
    );
    if (m) {
      const baseUnit = unitToSeconds(m[1]);
      if (baseUnit != null) return baseUnit * 1.5;
    }
  }

  // "30 seconds" / "thirty seconds" / "two minutes" / "twenty five seconds"
  {
    const m = lower.match(
      /(\d+(?:\.\d+)?|[a-z]+(?:[\s-][a-z]+){0,2})\s+(seconds?|secs?|minutes?|mins?|hours?|hrs?|m|s|h)\b/
    );
    if (m) {
      const n = parseNumber(m[1]);
      if (n != null) return toSeconds(n, m[2]);
    }
  }

  // "M:SS" — interpret as a timestamp-as-duration.
  {
    const ts = parseTimestamp(lower);
    if (ts != null) return ts;
  }

  return null;
}

/** Parse a timestamp in "M:SS" / "MM:SS" / "M:SS.ms" form. */
export function parseTimestamp(s: string): number | null {
  const trimmed = s.trim();
  // Split on : first; the last component may have .ms appended.
  const colonParts = trimmed.split(":");
  if (colonParts.length < 2) return null;
  const m = parseInt(colonParts[0], 10);
  const tail = colonParts.slice(1).join(":");
  if (Number.isNaN(m)) return null;

  // Tail can be "SS" or "SS.mmm" or "SS:mmm".
  const tailParts = tail.split(/[.:]/);
  const ss = parseInt(tailParts[0], 10);
  if (Number.isNaN(ss)) return null;
  let total = m * 60 + ss;
  if (tailParts.length > 1) {
    const ms = parseInt(tailParts[1], 10);
    if (!Number.isNaN(ms)) {
      // Pad: "5" → 500ms, "50" → 500ms, "500" → 500ms.
      const padded = (tailParts[1] + "000").slice(0, 3);
      total += parseInt(padded, 10) / 1000;
    }
    void ms;
  }
  return total;
}

/** Parse a number — accepts digits, English number words, or compound
 *  forms ("twenty five", "twenty-five", "thirty-five point five"). */
export function parseNumber(s: string): number | null {
  if (!s) return null;
  const trimmed = s.trim().toLowerCase();
  // Digit / decimal
  const num = parseFloat(trimmed);
  if (!Number.isNaN(num) && isFinite(num) && /^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return num;
  }
  // Single word
  if (NUMBER_WORDS[trimmed] != null) return NUMBER_WORDS[trimmed];

  // Compound: "twenty five" / "twenty-five" / "one hundred"
  const parts = trimmed.split(/[\s-]+/);
  let total = 0;
  let any = false;
  for (const p of parts) {
    if (NUMBER_WORDS[p] != null) {
      const v = NUMBER_WORDS[p];
      // hundred / thousand multiply the running total
      if ((v === 100 || v === 1000) && total > 0) {
        total *= v;
      } else {
        total += v;
      }
      any = true;
    } else {
      return null; // Unknown token — bail.
    }
  }
  return any ? total : null;
}

function unitToSeconds(unit: string): number | null {
  const u = unit.toLowerCase();
  if (/^seconds?$|^secs?$|^s$/.test(u)) return 1;
  if (/^minutes?$|^mins?$|^m$/.test(u)) return 60;
  if (/^hours?$|^hrs?$|^h$/.test(u)) return 3600;
  return null;
}

function toSeconds(n: number, unit: string): number {
  const factor = unitToSeconds(unit) ?? 1;
  return n * factor;
}

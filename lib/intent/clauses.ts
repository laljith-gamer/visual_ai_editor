/**
 * v1.7.7 — Clause splitter for compound intents.
 *
 * A user can say two things in one breath: "trim first 10 in first
 * video 5 in second video". The single-clause matchers only catch the
 * FIRST match; the rest is silently dropped, which surfaces to the
 * user as "the AI only understood half of what I said".
 *
 * This splitter looks for two structural patterns and returns the
 * clauses in order:
 *
 *   1. Explicit conjunctions: "and" / "," / ";" / "then" / "also" / "plus"
 *      "trim first 10 and last 5" → ["trim first 10", "last 5"]
 *
 *   2. Implicit per-source repeats: a "<duration> in/from <ordinal> video"
 *      pattern repeated 2+ times. The first clause keeps the leading
 *      verb phrase; subsequent clauses inherit it.
 *      "trim first 10 in first video 5 in second video"
 *        → ["trim first 10 in first video",
 *           "trim first 5 in second video"]
 *
 * Returns the original text as a single-element array when no split
 * is detected — single-clause path runs unchanged. The splitter is
 * intentionally conservative; false negatives (no split) are benign,
 * false positives would split mid-thought and produce nonsense ops.
 */

const ORDINAL =
  "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th";
const TIME_UNIT = "seconds?|secs?|minutes?|mins?|hours?|hrs?|m|s|h";

/** "<num> <unit> (in|from) <ordinal> [video|clip|source|one]?" — one
 *  per-source action group. Drives the implicit-split path. */
const SOURCE_GROUP_RE = new RegExp(
  `\\b(\\d+(?:\\.\\d+)?|[a-z]+(?:[\\s-][a-z]+){0,2})\\s+(?:${TIME_UNIT})\\s+(?:in|from)\\s+(?:the\\s+)?(?:${ORDINAL})(?:\\s+(?:video|clip|source|one))?`,
  "gi"
);

const CONJUNCTION_RE = /\s+(?:and(?:\s+also)?|,|;|then|plus|also)\s+/i;

export function splitIntoClauses(raw: string): string[] {
  const text = (raw ?? "").trim();
  if (!text) return [];

  // 1. Explicit conjunctions — user's deliberate "two things" signal.
  //    Both halves must be ≥3 chars to filter out trailers like " ok".
  const byConj = text.split(CONJUNCTION_RE);
  if (byConj.length > 1 && byConj.every((c) => c.trim().length >= 3)) {
    return byConj.map((c) => c.trim());
  }

  // 2. Implicit per-source repeats.
  const groups = [...text.matchAll(SOURCE_GROUP_RE)];
  if (groups.length >= 2) {
    const firstStart = groups[0].index ?? 0;
    const verbPrefix = text.slice(0, firstStart).trim();
    const out: string[] = [];
    // Clause 0: from start through the end of the first group.
    const firstEnd = (groups[0].index ?? 0) + groups[0][0].length;
    out.push(text.slice(0, firstEnd).trim());
    // Subsequent clauses: prefix + group, so the verb carries over.
    for (let i = 1; i < groups.length; i++) {
      const g = groups[i];
      const start = g.index ?? 0;
      const end = start + g[0].length;
      const segment = text.slice(start, end).trim();
      const synth = verbPrefix ? `${verbPrefix} ${segment}` : segment;
      out.push(synth.trim());
    }
    return out;
  }

  return [text];
}

/** True when splitIntoClauses would yield ≥ 2 clauses. */
export function hasMultipleClauses(raw: string): boolean {
  return splitIntoClauses(raw).length >= 2;
}

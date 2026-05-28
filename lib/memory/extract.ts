/**
 * v1.7.0 — Extract MemoryFact[] from the planner's structured output.
 *
 * The planner is asked to emit a `factsToRemember` array on every turn
 * (system-prompt contract). Each entry is a candidate fact to persist
 * for the rest of the session. We validate, normalise, and de-noise
 * them here before merging into the session store.
 *
 * Validation rules:
 *   - subject: required, snake_case, ≤ 48 chars.
 *   - value:   primitive or short string[]; objects/null rejected.
 *   - kind:    must be one of the five MemoryFact kinds; defaults to
 *              "context" when missing.
 *   - source:  must be one of the three sources; defaults to "inferred".
 *   - confidence: clamped to [0.4, 1] — anything below 0.4 isn't worth
 *                 spending the cookie space on.
 *   - reason:  optional, ≤ 160 chars.
 *
 * The planner is told it MAY emit zero facts on simple turns. Empty
 * input is the common case and returns [].
 */

import { newId } from "@/lib/util/id";
import type { MemoryFact } from "@/lib/types";

const VALID_KINDS = new Set([
  "intent",
  "preference",
  "context",
  "constraint",
  "feedback"
]);
const VALID_SOURCES = new Set(["explicit", "inferred", "feedback"]);
const MIN_CONFIDENCE = 0.4;
const MAX_FACTS_PER_TURN = 4;

/** Coerce one raw object into a MemoryFact, or return null if it
 *  doesn't pass validation. */
export function parseFact(raw: unknown): MemoryFact | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  // subject
  const rawSubject = typeof o.subject === "string" ? o.subject.trim() : "";
  if (!rawSubject) return null;
  const subject = rawSubject
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  if (!subject) return null;

  // value
  let value: MemoryFact["value"];
  if (
    typeof o.value === "string" ||
    typeof o.value === "number" ||
    typeof o.value === "boolean"
  ) {
    value =
      typeof o.value === "string" ? o.value.slice(0, 120) : o.value;
  } else if (
    Array.isArray(o.value) &&
    o.value.every((x) => typeof x === "string")
  ) {
    value = (o.value as string[]).slice(0, 6).map((s) => s.slice(0, 60));
  } else {
    return null;
  }

  // kind
  const kind = (typeof o.kind === "string" && VALID_KINDS.has(o.kind)
    ? o.kind
    : "context") as MemoryFact["kind"];

  // source
  const source = (typeof o.source === "string" && VALID_SOURCES.has(o.source)
    ? o.source
    : "inferred") as MemoryFact["source"];

  // confidence — clamp to [MIN_CONFIDENCE, 1]
  let confidence: number;
  if (typeof o.confidence === "number" && Number.isFinite(o.confidence)) {
    confidence = Math.min(1, Math.max(0, o.confidence));
  } else {
    confidence = 0.7; // sensible default for a model-emitted fact
  }
  if (confidence < MIN_CONFIDENCE) return null;

  const reason =
    typeof o.reason === "string" && o.reason.trim()
      ? o.reason.trim().slice(0, 160)
      : undefined;

  const now = Date.now();
  return {
    id: newId("f"),
    ts: now,
    lastSeen: now,
    kind,
    subject,
    value,
    source,
    confidence,
    reason
  };
}

/** Top-level helper. Reads the `factsToRemember` field from the
 *  planner's parsed JSON, validates each entry, dedupes by subject
 *  (last write wins for the turn), and caps the array length. */
export function extractFacts(parsed: Record<string, unknown>): MemoryFact[] {
  const raw = parsed.factsToRemember;
  if (!Array.isArray(raw)) return [];
  const out = new Map<string, MemoryFact>();
  for (const item of raw) {
    const fact = parseFact(item);
    if (!fact) continue;
    out.set(fact.subject, fact);
    if (out.size >= MAX_FACTS_PER_TURN) break;
  }
  return Array.from(out.values());
}

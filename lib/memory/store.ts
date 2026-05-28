/**
 * v1.7.0 — Per-session memory fact store.
 *
 * Facts are persisted on the iron-session cookie keyed by the user's
 * sid. We deliberately avoid a separate Redis namespace so memory has
 * the same lifetime as the session itself (30 days, see cookie.ts) and
 * inherits the same encrypted-cookie privacy model — never crosses
 * sessions, never leaves the user's browser unencrypted.
 *
 * Capacity is tight by design: iron-session is hard-capped at ~4 KB
 * after encryption. We cap at 10 facts × ~180 chars each ≈ 1.8 KB so
 * the cookie has plenty of headroom for the existing `sid` + `createdAt`
 * fields and any future additions.
 *
 * Eviction policy on overflow: lowest (confidence × recencyScore) loses.
 * recencyScore decays per turn so old, low-confidence facts naturally
 * make room for fresh ones — without us needing a write-time call.
 */

import type { MemoryFact } from "@/lib/types";

/** Hard cap on number of facts we keep per session. */
const MAX_FACTS = 10;

/** Minimum confidence required to retain a fact through eviction. */
const MIN_RETAIN_CONFIDENCE = 0.25;

/** Age (ms) at which a fact is considered "old" for ranking purposes. */
const RECENCY_HALF_LIFE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

/**
 * Merge a batch of newly-extracted facts into an existing list.
 *
 * Rules:
 *   - Same `subject` → reinforce the existing fact (bump confidence
 *     toward 1, refresh lastSeen, keep the older `ts`). The new
 *     fact's value WINS unless the new confidence is materially
 *     lower; this lets later turns correct earlier inferences
 *     ("oh I do want a render after all").
 *   - New `subject` → add as-is, allocating a fresh id.
 *   - Capacity exceeded → drop the lowest-ranked fact.
 */
export function mergeFacts(
  existing: MemoryFact[],
  fresh: MemoryFact[]
): MemoryFact[] {
  if (fresh.length === 0) return existing.slice();
  const bySubject = new Map<string, MemoryFact>();
  for (const f of existing) bySubject.set(f.subject, { ...f });

  const now = Date.now();
  for (const incoming of fresh) {
    const prior = bySubject.get(incoming.subject);
    if (!prior) {
      bySubject.set(incoming.subject, { ...incoming, lastSeen: now });
      continue;
    }
    // Reinforce — same subject. Newer value wins unless its
    // confidence is much lower (≥ 0.2 below prior). Confidence
    // climbs toward 1 each time we see the fact again.
    const keepNew =
      incoming.confidence >= prior.confidence - 0.2 ||
      incoming.source === "explicit";
    bySubject.set(incoming.subject, {
      ...prior,
      value: keepNew ? incoming.value : prior.value,
      kind: keepNew ? incoming.kind : prior.kind,
      reason: keepNew ? incoming.reason ?? prior.reason : prior.reason,
      source: incoming.source === "explicit" ? "explicit" : prior.source,
      confidence: Math.min(1, Math.max(prior.confidence, incoming.confidence) + 0.05),
      lastSeen: now
    });
  }

  return capacityEvict(Array.from(bySubject.values()));
}

/**
 * Apply a small per-call decay on every existing fact's confidence.
 * Called once per turn before merging fresh extractions, so facts
 * that the planner doesn't re-mention slowly fade.
 */
export function decayFacts(facts: MemoryFact[]): MemoryFact[] {
  if (facts.length === 0) return facts;
  return facts
    .map((f) => ({ ...f, confidence: Math.max(0, f.confidence - 0.02) }))
    .filter((f) => f.confidence >= MIN_RETAIN_CONFIDENCE);
}

/**
 * Score a fact for ranking & eviction decisions. Higher is more useful.
 * Combines confidence with a recency curve (exponential half-life).
 */
export function scoreFact(f: MemoryFact, now: number = Date.now()): number {
  const ageMs = Math.max(0, now - f.lastSeen);
  const recency = Math.exp(-ageMs / RECENCY_HALF_LIFE_MS);
  // Explicit + intent facts are slightly privileged — they're the kind
  // the user is most likely to notice if forgotten.
  const kindBonus = f.kind === "intent" ? 0.08 : 0;
  const sourceBonus = f.source === "explicit" ? 0.06 : 0;
  return f.confidence * 0.7 + recency * 0.3 + kindBonus + sourceBonus;
}

function capacityEvict(facts: MemoryFact[]): MemoryFact[] {
  if (facts.length <= MAX_FACTS) return facts;
  const now = Date.now();
  const ranked = facts
    .map((f) => ({ f, s: scoreFact(f, now) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, MAX_FACTS)
    .map((x) => x.f);
  return ranked;
}

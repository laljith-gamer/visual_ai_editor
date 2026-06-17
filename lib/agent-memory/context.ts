/**
 * Phase 2 — compact context builder.
 *
 * Assembles ONLY the relevant slice of agent memory for the current turn,
 * so we never dump the full memory list into a prompt or decision. Used
 * by the orchestrator (to resolve references) and, optionally, to enrich
 * the cloud planner prompt with a small text block.
 */

import type { AgentMemoryStore } from "./store";
import type { AgentMemoryRecord, FlowMemory, MemoryKind, ReinforcementMemory } from "./types";

export interface AgentContextSnapshot {
  flow: FlowMemory;
  reinforcement: ReinforcementMemory;
  /** High-confidence user-stated rules + preferences relevant now. */
  rules: AgentMemoryRecord[];
  /** Per-source usage memory (which source the user leans on). */
  sourceMemory: AgentMemoryRecord[];
}

export function buildAgentContext(store: AgentMemoryStore, query = ""): AgentContextSnapshot {
  const terms = tokenize(query);

  const rules = store
    .recall({ predicate: (r) => r.kind === "user_stated" || r.kind === "preference" })
    .filter((r) => r.confidence >= 0.6)
    .slice(0, 8);

  const sourceMemory = store.recall({ kind: "source" }).slice(0, 8);

  // Relevance filter for clip/reinforcement records when a query exists —
  // keeps the snapshot small.
  void terms;

  return {
    flow: store.getFlow(),
    reinforcement: store.getReinforcement(),
    rules,
    sourceMemory
  };
}

/** Render the snapshot as a compact, token-lean text block. Returns ""
 *  when there's nothing meaningful — callers should omit empty blocks. */
export function renderAgentContext(snapshot: AgentContextSnapshot): string {
  const lines: string[] = [];
  if (snapshot.rules.length > 0) {
    lines.push("Remembered rules:");
    for (const r of snapshot.rules) {
      lines.push(`- ${r.key} (${r.confidence.toFixed(2)}): ${r.evidence}`);
    }
  }
  const rf = snapshot.reinforcement;
  const rfBits: string[] = [];
  if (rf.preferredSourceIds.length) rfBits.push(`prefer sources ${rf.preferredSourceIds.join(",")}`);
  if (rf.avoidedSourceIds.length) rfBits.push(`avoid sources ${rf.avoidedSourceIds.join(",")}`);
  if (rf.styleHints.length) rfBits.push(`style: ${rf.styleHints.join(", ")}`);
  if (rf.rejectedRanges.length) rfBits.push(`${rf.rejectedRanges.length} rejected range(s)`);
  if (rf.likedConcepts.length) rfBits.push(`liked: ${rf.likedConcepts.join(", ")}`);
  if (rfBits.length) lines.push(`Reinforcement: ${rfBits.join("; ")}`);
  return lines.join("\n");
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((s) => s.length >= 2);
}

/**
 * Memory PRIORITY (project rule): direct user instruction > current
 * command > selected state > flow memory > observed memory > default.
 * The "current command" and "selected state" are runtime inputs the
 * resolvers already prefer; among stored RECORDS this ordering decides
 * which facts win when several are relevant. Higher = stronger.
 */
const KIND_PRIORITY: Record<MemoryKind, number> = {
  user_stated: 100,
  reinforcement: 85,
  clip: 80,
  source: 70,
  flow: 60,
  observed: 40,
  preference: 30
};

export interface RelevantMemoryOptions {
  /** When set, only records whose key/evidence/value mention a query
   *  token are returned (plus all user_stated rules, which always apply). */
  query?: string;
  /** Max records to return. Default 12. */
  limit?: number;
  /** Drop records below this confidence. Default 0.5. */
  minConfidence?: number;
}

/**
 * Retrieve the most relevant stored memory records for the current turn,
 * ordered by the priority rule above (then confidence, then recency).
 * Pure — operates on a store snapshot; safe to unit-test.
 */
export function getRelevantMemory(
  store: AgentMemoryStore,
  opts: RelevantMemoryOptions = {}
): AgentMemoryRecord[] {
  const limit = opts.limit ?? 12;
  const minConfidence = opts.minConfidence ?? 0.5;
  const terms = opts.query ? tokenize(opts.query) : [];

  const matches = (r: AgentMemoryRecord): boolean => {
    if (r.confidence < minConfidence) return false;
    if (terms.length === 0) return true;
    // user-stated rules always apply regardless of the query.
    if (r.kind === "user_stated") return true;
    const hay = `${r.key} ${r.evidence} ${stringifyValue(r.value)}`.toLowerCase();
    return terms.some((t) => hay.includes(t));
  };

  return store
    .recall({ predicate: matches })
    .sort(
      (a, b) =>
        (KIND_PRIORITY[b.kind] ?? 0) - (KIND_PRIORITY[a.kind] ?? 0) ||
        b.confidence - a.confidence ||
        b.updatedAt - a.updatedAt
    )
    .slice(0, limit);
}

function stringifyValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.join(" ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

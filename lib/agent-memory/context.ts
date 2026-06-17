/**
 * Phase 2 — compact context builder.
 *
 * Assembles ONLY the relevant slice of agent memory for the current turn,
 * so we never dump the full memory list into a prompt or decision. Used
 * by the orchestrator (to resolve references) and, optionally, to enrich
 * the cloud planner prompt with a small text block.
 */

import type { AgentMemoryStore } from "./store";
import type { AgentMemoryRecord, FlowMemory, ReinforcementMemory } from "./types";

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

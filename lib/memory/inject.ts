/**
 * v1.7.0 — Format a MemoryFact[] into a planner-prompt block.
 *
 * The block is appended to the user-prompt context as an authoritative
 * "What I remember about this session" section. The planner is told
 * to treat these as soft truths — they bias decisions but the user's
 * latest message can always override.
 *
 * Top-K filtering: we sort by scoreFact() (confidence × recency with
 * kind/source bonuses) and keep at most TOP_K. The cap exists because
 * very long memory blocks dominate the planner's attention and start
 * making it ignore the actual user message.
 */

import type { MemoryFact } from "@/lib/types";
import { scoreFact } from "./store";

const TOP_K = 8;

/** Render a single fact as a one-line string for the prompt. */
function renderFact(f: MemoryFact): string {
  const valueStr = Array.isArray(f.value)
    ? f.value.slice(0, 4).join(", ")
    : String(f.value);
  const reason = f.reason ? ` — ${f.reason}` : "";
  // Emit the subject in human-readable form (snake_case → spaces).
  const human = f.subject.replace(/_/g, " ");
  return `  - (${f.kind}) ${human}: ${valueStr}${reason}`;
}

/** Build the full memory block. Returns an empty string when there's
 *  nothing to inject — the caller can then skip adding the section
 *  header entirely so empty turns don't waste tokens. */
export function buildMemoryBlock(facts: MemoryFact[]): string {
  if (facts.length === 0) return "";
  const ranked = facts
    .map((f) => ({ f, s: scoreFact(f) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, TOP_K)
    .map((x) => x.f);
  // Within the kept set, group by kind for readability (intent first,
  // then preference, then everything else). The planner's prompt
  // documents the priority — keeping the order stable matters.
  const order: Record<MemoryFact["kind"], number> = {
    intent: 0,
    preference: 1,
    constraint: 2,
    context: 3,
    feedback: 4
  };
  ranked.sort((a, b) => order[a.kind] - order[b.kind]);
  const lines = [
    "What I remember about this session (treat as soft truths; user's latest words always win on conflict):"
  ];
  for (const f of ranked) lines.push(renderFact(f));
  return lines.join("\n");
}

/**
 * Phase 2 — local-first agent memory store.
 *
 * In-memory primary store (fast, synchronous, testable with zero deps).
 * It exposes `serialize()` / `hydrate()` so a thin adapter can persist it
 * to IndexedDB via the existing `lib/store/idb.ts` layer per session —
 * but the core stays import-free so unit tests and the dev tester can use
 * it directly. No backend; nothing leaves the browser.
 *
 * Upsert semantics: records are keyed by `${kind}:${key}` so repeating an
 * observation REINFORCES the existing record (bumps confidence, refreshes
 * `updatedAt`, appends evidence) instead of duplicating it.
 */

import type {
  AgentMemoryRecord,
  FlowMemory,
  MemoryKind,
  ReinforcementMemory
} from "./types";
import { emptyFlow, emptyReinforcement } from "./types";

let counter = 0;
function genId(): string {
  counter += 1;
  return `mem_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export interface RememberInput {
  kind: MemoryKind;
  key: string;
  value: unknown;
  confidence: number;
  evidence: string;
  source: AgentMemoryRecord["source"];
  scope?: AgentMemoryRecord["scope"];
  sourceId?: string;
  clipId?: string;
  ttlMs?: number;
}

export interface SerializedAgentMemory {
  records: AgentMemoryRecord[];
  flow: FlowMemory;
  reinforcement: ReinforcementMemory;
}

/** How much a repeat observation increases confidence (capped at 0.98). */
const REINFORCE_STEP = 0.08;
const MAX_CONFIDENCE = 0.98;

export class AgentMemoryStore {
  private records = new Map<string, AgentMemoryRecord>();
  private flow: FlowMemory = emptyFlow();
  private reinforcement: ReinforcementMemory = emptyReinforcement();

  // ---- records ----------------------------------------------------
  remember(input: RememberInput): AgentMemoryRecord {
    const mapKey = `${input.kind}:${input.key}`;
    const now = Date.now();
    const existing = this.records.get(mapKey);
    if (existing) {
      existing.value = input.value;
      existing.confidence = Math.min(MAX_CONFIDENCE, Math.max(existing.confidence, input.confidence) + REINFORCE_STEP);
      existing.evidence = input.evidence;
      existing.updatedAt = now;
      if (input.ttlMs) existing.expiresAt = now + input.ttlMs;
      return existing;
    }
    const rec: AgentMemoryRecord = {
      id: genId(),
      kind: input.kind,
      key: input.key,
      value: input.value,
      confidence: Math.min(MAX_CONFIDENCE, input.confidence),
      evidence: input.evidence,
      source: input.source,
      scope: input.scope ?? "session",
      sourceId: input.sourceId,
      clipId: input.clipId,
      createdAt: now,
      updatedAt: now,
      expiresAt: input.ttlMs ? now + input.ttlMs : undefined
    };
    this.records.set(mapKey, rec);
    return rec;
  }

  /** Retrieve non-expired records, optionally filtered by kind / predicate. */
  recall(opts?: { kind?: MemoryKind; predicate?: (r: AgentMemoryRecord) => boolean }): AgentMemoryRecord[] {
    const now = Date.now();
    const out: AgentMemoryRecord[] = [];
    for (const r of this.records.values()) {
      if (r.expiresAt && r.expiresAt < now) continue;
      if (opts?.kind && r.kind !== opts.kind) continue;
      if (opts?.predicate && !opts.predicate(r)) continue;
      out.push(r);
    }
    return out.sort((a, b) => b.confidence - a.confidence || b.updatedAt - a.updatedAt);
  }

  get(kind: MemoryKind, key: string): AgentMemoryRecord | undefined {
    const r = this.records.get(`${kind}:${key}`);
    if (r && r.expiresAt && r.expiresAt < Date.now()) return undefined;
    return r;
  }

  forget(kind: MemoryKind, key: string): boolean {
    return this.records.delete(`${kind}:${key}`);
  }

  // ---- flow -------------------------------------------------------
  getFlow(): FlowMemory {
    return this.flow;
  }

  setFlow(patch: Partial<FlowMemory>): FlowMemory {
    this.flow = { ...this.flow, ...patch };
    return this.flow;
  }

  /** Record that the agent created clips this turn (for "that clip"). */
  noteCreatedClips(ids: string[]): void {
    if (ids.length === 0) return;
    this.flow.lastCreatedClipIds = ids.slice(-8);
  }

  // ---- reinforcement ----------------------------------------------
  getReinforcement(): ReinforcementMemory {
    return this.reinforcement;
  }

  applyReinforcement(patch: Partial<ReinforcementMemory>): ReinforcementMemory {
    const r = this.reinforcement;
    const mergeUnique = <T>(a: T[], b: T[] | undefined): T[] =>
      b ? Array.from(new Set([...a, ...b])).slice(-50) : a;
    this.reinforcement = {
      rejectedClipIds: mergeUnique(r.rejectedClipIds, patch.rejectedClipIds),
      likedClipIds: mergeUnique(r.likedClipIds, patch.likedClipIds),
      rejectedRanges: patch.rejectedRanges ? [...r.rejectedRanges, ...patch.rejectedRanges].slice(-50) : r.rejectedRanges,
      likedRanges: patch.likedRanges ? [...r.likedRanges, ...patch.likedRanges].slice(-50) : r.likedRanges,
      likedConcepts: mergeUnique(r.likedConcepts, patch.likedConcepts),
      rejectedConcepts: mergeUnique(r.rejectedConcepts, patch.rejectedConcepts),
      preferredSourceIds: mergeUnique(r.preferredSourceIds, patch.preferredSourceIds),
      avoidedSourceIds: mergeUnique(r.avoidedSourceIds, patch.avoidedSourceIds),
      styleHints: mergeUnique(r.styleHints, patch.styleHints)
    };
    return this.reinforcement;
  }

  // ---- lifecycle --------------------------------------------------
  clear(): void {
    this.records.clear();
    this.flow = emptyFlow();
    this.reinforcement = emptyReinforcement();
  }

  serialize(): SerializedAgentMemory {
    return {
      records: [...this.records.values()],
      flow: this.flow,
      reinforcement: this.reinforcement
    };
  }

  hydrate(data: Partial<SerializedAgentMemory> | null | undefined): void {
    if (!data) return;
    this.records.clear();
    for (const r of data.records ?? []) {
      this.records.set(`${r.kind}:${r.key}`, r);
    }
    this.flow = { ...emptyFlow(), ...(data.flow ?? {}) };
    this.reinforcement = { ...emptyReinforcement(), ...(data.reinforcement ?? {}) };
  }
}

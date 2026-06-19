// =====================================================================
// lib/store/projectSignature.ts
//
// PURE project-persistence signature. No React, no zustand, no IndexedDB.
//
// WHY THIS EXISTS
// ---------------
// The editor's autosave used to fire only on `highlights.length`,
// `plan?.scenarios.length`, and `messages.length`. That misses most durable
// project state — source uploads/hydration, missing placeholders, the
// active/selected source, the selected clip, boundary transitions, pending
// op/exec, mode, inferred chips, user tier, last briefing, memory, etc. So a
// project could change in memory yet never get written, and a reload showed
// stale data.
//
// `projectPersistSignature(state)` produces a STABLE string that changes iff
// some piece of *durable* project state changed. The editor watches it and
// debounces a `persist()`. Transient values (notably `progress`) are
// deliberately excluded so a running pipeline's progress ticks never spam
// IndexedDB.
//
// It is intentionally a structural subset of the store state, so the store
// can call `projectPersistSignature(get())` directly and it stays trivially
// unit-testable.
// =====================================================================

import type {
  ChatMessage,
  EditPlan,
  Highlight,
  InferredField,
  IntentMode,
  JobStatus,
  SessionMemory,
  UserTier
} from "../types";
import type { BoundaryTransition } from "../transitions/types";

/** The minimal, durable slice of editor state the signature reads. The full
 *  store state is structurally assignable to this (extra fields ignored). */
export interface ProjectSignatureInput {
  sessionId: string;
  title: string;
  sources: Array<{ id: string; hash: string; meta: { name: string }; addedAt: number }>;
  missingSources: Array<{ id: string; hash: string }>;
  activeSourceId: string | null;
  selectedSourceIds: string[];
  plan: EditPlan | null;
  highlights: Highlight[];
  selectedClipId: string | null;
  boundaryTransitions: BoundaryTransition[];
  pendingTimelineOp: "append" | "replace";
  pendingExecution: boolean;
  mode: IntentMode | null;
  inferred: InferredField[];
  userTier: UserTier;
  lastBriefing: { id: string; sourceId: string; bestParts: unknown[] } | null;
  messages: ChatMessage[];
  memory: SessionMemory;
  /** Included because a persisted status (idle/ready/completed/needs_review)
   *  is useful on restore. `progress` is INTENTIONALLY excluded — see file
   *  header — so per-frame progress ticks don't trigger a save. */
  status: JobStatus;
}

function val(v: string | number | boolean | string[]): string {
  return Array.isArray(v) ? v.join(",") : String(v);
}

/** Compact, complete plan identity. The plan only changes via setPlan /
 *  applyPlanPatch (durable edits), so a full structural stringify is both
 *  cheap (plans are small) and guaranteed to catch any plan change. */
function planSignature(plan: EditPlan | null): string {
  if (!plan) return "";
  return JSON.stringify({
    sc: plan.scenarios.map((s) => `${s.id}:${s.prompt}:${s.weight ?? 1}`),
    lw: plan.labelWeights,
    tgt: plan.targetShortSeconds,
    usd: plan.userSpecifiedDuration,
    qf: plan.qualityFloor ?? null,
    maxC: plan.maxClipSeconds,
    minC: plan.minClipSeconds,
    strat: plan.selectionStrategy,
    fmt: plan.format,
    tr: plan.transition,
    st: plan.styles,
    av: plan.avoid,
    sig: plan.signals ?? null,
    ex: plan.extractRange ?? null,
    src: plan.sources ?? null
  });
}

function memorySignature(m: SessionMemory): string {
  return JSON.stringify({
    d: m.duration ?? null,
    f: m.format ?? null,
    s: m.styles,
    k: m.keep,
    sk: m.skip
  });
}

/**
 * Stable signature of all DURABLE project state. Two states with the same
 * signature are considered "already saved"; a changed signature means the
 * project should be persisted. Deterministic for a given input.
 */
export function projectPersistSignature(s: ProjectSignatureInput): string {
  const lastMsg = s.messages.length > 0 ? s.messages[s.messages.length - 1] : null;

  const sig = {
    session: s.sessionId,
    title: s.title,
    // source ids + hashes + names + addedAt
    sources: (s.sources ?? []).map(
      (x) => `${x.id}:${x.hash}:${x.meta.name}:${x.addedAt}`
    ),
    // missing placeholders by id + hash
    missing: (s.missingSources ?? []).map((x) => `${x.id}:${x.hash}`),
    active: s.activeSourceId ?? "",
    selected: s.selectedSourceIds ?? [],
    plan: planSignature(s.plan),
    // highlight identity that matters for restore + render
    highlights: (s.highlights ?? []).map(
      (h) => `${h.id}:${h.sourceId ?? ""}:${h.start}:${h.end}:${h.label ?? ""}`
    ),
    selectedClip: s.selectedClipId ?? "",
    transitions: (s.boundaryTransitions ?? []).map(
      (t) =>
        `${t.index}:${t.type}:${t.mode ?? ""}:${t.durationSeconds ?? ""}:${t.render ?? ""}`
    ),
    pendingOp: s.pendingTimelineOp,
    pendingExec: s.pendingExecution,
    mode: s.mode ?? "",
    inferred: (s.inferred ?? []).map((f) => `${f.field}=${val(f.value)}`),
    tier: s.userTier,
    briefing: s.lastBriefing
      ? `${s.lastBriefing.id}:${s.lastBriefing.sourceId}:${s.lastBriefing.bestParts.length}`
      : "",
    // messages: length + last id/timestamp (cheap; catches append + edit)
    messages: `${s.messages.length}:${lastMsg?.id ?? ""}:${lastMsg?.timestamp ?? ""}`,
    memory: memorySignature(s.memory),
    status: s.status
  };

  return JSON.stringify(sig);
}

/**
 * Client runner — bridges the agentic orchestrator to the editor store.
 *
 * Mirrors lib/intent/dispatch.ts (the existing quick-shortcut bridge): it
 * builds a context snapshot from the live store, runs the orchestrator,
 * and applies the resolved AgentDecision via the store's actions. It is
 * ADDITIVE and REVERSIBLE — `handleAgent` calls it BEFORE the existing
 * `tryQuickShortcut` + cloud planner, and a `false` return falls straight
 * through to those unchanged paths. It never re-pushes the user message
 * (the editor already did).
 *
 * Per-session agent memory lives in a module-scoped map (in-memory,
 * local-first; survives the tab session). The store exposes serialize/
 * hydrate so IndexedDB persistence can be layered on later without
 * call-site changes.
 *
 * Phase 8 UI feedback: every applied action pushes ONE assistant message
 * carrying the confirmation + any assumptions ("Using video 2 because…")
 * and an `agent` attachment with the evidence label ("transcript match",
 * "exact range") so the chat surface can show why a clip was chosen.
 */

import { useEditorStore } from "@/hooks/useEditorStore";
import type { Highlight, JobStatus } from "@/lib/types";
import type { Transcript } from "@/lib/audio/types";
import type { AgentCommandContext } from "@/lib/intent/command";
import { AgentMemoryStore } from "@/lib/agent-memory/store";
import {
  addClipRef,
  addClips,
  extendClip,
  moveClip,
  removeClip,
  replaceClip,
  trimClip
} from "@/lib/timeline/operations";
import { orchestrate, type AgentDecision, type ResolvedOp } from "./orchestrator";
import { classifyFastCommand, decideFastAction, type FastCommand } from "@/lib/intent/fastCommands";
import { hydrateAgentMemory, saveAgentMemory } from "@/lib/agent-memory/persistence";
import { parseTransitionCommand, type TransitionCommand } from "@/lib/intent/transitionCommands";
import { parseMetaQuestion } from "@/lib/intent/metaQuestions";
import { answerMetaQuestion, type MetaAnswerState } from "@/lib/agent/metaAnswer";
import { mapTransition } from "@/lib/transitions/map";
import { normalizeTransitionDuration, type BoundaryTransition } from "@/lib/transitions/types";

// ---- per-session agent memory --------------------------------------
const memoryBySession = new Map<string, AgentMemoryStore>();
/** Sessions whose persisted memory has been hydrated (once per tab). */
const hydratedSessions = new Set<string>();

export function getAgentMemory(sessionId: string): AgentMemoryStore {
  let m = memoryBySession.get(sessionId);
  if (!m) {
    m = new AgentMemoryStore();
    memoryBySession.set(sessionId, m);
  }
  return m;
}

/** Hydrate a session's memory from IndexedDB exactly once (offline
 *  persistence). Safe to call every turn — it no-ops after the first. */
async function ensureHydrated(sessionId: string, store: AgentMemoryStore): Promise<void> {
  if (hydratedSessions.has(sessionId)) return;
  hydratedSessions.add(sessionId);
  try {
    await hydrateAgentMemory(sessionId, store);
  } catch {
    // Non-fatal — proceed with empty in-memory state.
  }
}

export interface AgentCommandDeps {
  pushMessage: (msg: {
    role: "user" | "assistant";
    content: string;
    attachment?: Record<string, unknown>;
  }) => void;
  setStatus: (status: JobStatus, detail?: string) => void;
  setProgress: (n: number) => void;
  sessionId: string;
  logSession: {
    ai: (kind: string, payload: Record<string, unknown>, summary?: string) => void;
    system: (kind: string, payload: Record<string, unknown>, summary?: string) => void;
  };
  /** Optional render trigger for the "render" op. */
  onRender?: () => void;
  /** Optional export/download trigger for the "export" command. Returns a
   *  message to surface in chat (success / blocked / etc.). */
  onExport?: () => Promise<{ ok: boolean; message: string }>;
}

export interface AgentCommandOutcome {
  /** True when the agent fully handled the turn (skip quickMatch + cloud). */
  handled: boolean;
  /** True when the turn needs the visual pipeline — caller falls through
   *  to the cloud planner (which builds scenarios + runs the pipeline). */
  needsVisual?: boolean;
}

function buildContext(memory: AgentMemoryStore): {
  ctx: AgentCommandContext;
  getTranscript: (sourceId: string) => Transcript | null;
} {
  const s = useEditorStore.getState();
  const flow = memory.getFlow();
  const hashById = new Map(s.sources.map((src) => [src.id, src.hash]));
  const transcriptAvailableSourceIds = s.sources
    .filter((src) => !!s.transcripts[src.hash])
    .map((src) => src.id);

  const ctx: AgentCommandContext = {
    sources: s.sources.map((src) => ({ id: src.id, name: src.meta.name, duration: src.meta.duration })),
    activeSourceId: s.activeSourceId,
    lastUsedSourceId: flow.activeSourceId ?? s.activeSourceId,
    selectedSourceIds: [...s.selectedSourceIds],
    highlights: s.highlights.map((h) => ({ id: h.id, start: h.start, end: h.end, sourceId: h.sourceId, label: h.label })),
    selectedClipId: s.selectedClipId,
    lastCreatedClipIds: flow.lastCreatedClipIds,
    transcriptAvailableSourceIds
  };

  const getTranscript = (sourceId: string): Transcript | null => {
    const hash = hashById.get(sourceId);
    return hash ? s.transcripts[hash] ?? null : null;
  };

  return { ctx, getTranscript };
}

/** Snapshot the store into the read-only state the meta answerer needs. */
function buildMetaAnswerState(): MetaAnswerState {
  const s = useEditorStore.getState();
  const lastAssistant =
    [...s.messages].reverse().find((m) => m.role === "assistant")?.content ?? null;
  return {
    plan: s.plan
      ? {
          targetShortSeconds: s.plan.targetShortSeconds,
          userSpecifiedDuration: s.plan.userSpecifiedDuration,
          format: s.plan.format,
          transition: s.plan.transition,
          scenarios: s.plan.scenarios?.map((sc) => ({ id: sc.id, prompt: sc.prompt })),
          rationale: s.plan.rationale
        }
      : null,
    highlights: s.highlights.map((h) => ({
      id: h.id,
      start: h.start,
      end: h.end,
      label: h.label,
      reason: h.reason,
      sourceId: h.sourceId,
      score: h.score
    })),
    selectedClipId: s.selectedClipId,
    boundaryTransitions: s.boundaryTransitions.map((t) => ({
      index: t.index,
      type: t.type,
      mode: t.mode,
      render: t.render,
      exact: t.exact,
      note: t.note
    })),
    memory: s.memory,
    sources: s.sources.map((src) => ({ id: src.id, name: src.meta.name })),
    lastAssistantMessage: lastAssistant,
    lastUserMessage: null
  };
}

/** Entry point called from the editor BEFORE the quick-shortcut gate. */
export async function tryAgentCommand(
  userText: string,
  deps: AgentCommandDeps
): Promise<AgentCommandOutcome> {
  // ---- Meta / explanation question guard (READ-ONLY, double safety) -
  // The editor already runs this before tryAgentCommand, but guarding here
  // too means ANY caller (e.g. the dev intent tester) can never mutate the
  // timeline on an explanation question. Read-only: it only pushes an
  // answer built from current state.
  const meta = parseMetaQuestion(userText);
  if (meta && meta.confidence >= 0.6) {
    const answer = answerMetaQuestion(meta, { ...buildMetaAnswerState(), questionText: userText });
    deps.pushMessage({ role: "assistant", content: answer, attachment: { mode: "meta", kind: meta.kind } });
    deps.logSession.ai("meta.explained", { kind: meta.kind, target: meta.target }, answer.slice(0, 140));
    return { handled: true };
  }

  // ---- Phase 1: fast control commands (never reach the planner) -----
  // Confirmations, undo/redo, and render are resolved instantly here.
  // Anchored matching means partial commands ("go to clip 2", "render
  // the part where he scores") are NOT caught and flow on to parsing.
  const fast = classifyFastCommand(userText);
  if (fast) {
    const outcome = await handleFastCommand(fast, deps);
    if (outcome) {
      if (outcome.handled) {
        deps.logSession.ai("agent.fast", { kind: fast.kind }, `Fast command: ${fast.kind}`);
      }
      return outcome;
    }
    // outcome === null → intentionally fall through (e.g. affirm/cancel
    // WITH a pending action, which the existing quick-shortcut gate
    // handles end-to-end).
  }

  // ---- Transition commands (deterministic, before the planner) ------
  const transitionCmd = parseTransitionCommand(userText);
  if (transitionCmd) {
    deps.logSession.ai("agent.transition", { kind: transitionCmd.kind }, `Transition command: ${transitionCmd.kind}`);
    return handleTransitionCommand(transitionCmd, deps);
  }

  const memory = getAgentMemory(deps.sessionId);
  await ensureHydrated(deps.sessionId, memory);
  const { ctx, getTranscript } = buildContext(memory);

  let decision: AgentDecision;
  try {
    decision = await orchestrate({ text: userText, ctx, memory, getTranscript });
  } catch (err) {
    deps.logSession.system("agent.command.failed", { message: (err as Error).message }, "Agent command path errored; falling through.");
    return { handled: false };
  }

  // Persist memory after any turn that may have mutated it (the orchestrator
  // observes the message + applies reinforcement). Fire-and-forget so a
  // storage hiccup never blocks editing.
  if (decision.kind !== "fallthrough") {
    void saveAgentMemory(deps.sessionId, memory);
  }

  switch (decision.kind) {
    case "fallthrough":
      return { handled: false };

    case "needs_visual":
      // Honest hand-off: let the cloud planner + pipeline do the visual
      // search. Memory (incl. reinforcement) is already updated for it.
      deps.logSession.ai("agent.command.needs_visual", { concept: decision.concept }, decision.reason);
      return { handled: false, needsVisual: true };

    case "reinforcement_only":
      deps.pushMessage({ role: "assistant", content: decision.message, attachment: { mode: "agent", kind: "reinforcement" } });
      deps.logSession.ai("agent.reinforcement", {}, decision.message);
      return { handled: true };

    case "clarify":
      deps.pushMessage({
        role: "assistant",
        content: decision.message,
        attachment: { mode: "agent", kind: "clarify", suggestions: decision.suggestions }
      });
      useEditorStore.getState().setPendingClarify({
        message: decision.message,
        questions: [
          {
            id: "agent-clarify",
            prompt: decision.message,
            suggestions: decision.suggestions,
            kind: decision.suggestions.length > 0 ? "single-choice" : "free-text"
          }
        ]
      });
      return { handled: true };

    case "operations": {
      const applied = applyOps(decision.ops, memory, deps);
      if (!applied.anyChange && decision.ops.every((o) => o.type !== "render")) {
        // Nothing actually changed (e.g. clip vanished) — be honest and
        // fall through so the cloud planner can try.
        return { handled: false };
      }
      const lines = [decision.message, ...decision.assumptions];
      deps.pushMessage({
        role: "assistant",
        content: lines.join("\n"),
        attachment: { mode: "agent", evidence: decision.evidence, confidence: decision.confidence }
      });
      const after = useEditorStore.getState().highlights;
      deps.setStatus(after.length > 0 ? "ready" : "idle", after.length > 0 ? "Ready to render" : undefined);
      deps.setProgress(after.length > 0 ? 1 : 0);
      deps.logSession.ai("agent.command.applied", { ops: decision.ops.map((o) => o.type), evidence: decision.evidence }, decision.message);
      return { handled: true };
    }

    default:
      return { handled: false };
  }
}

// ---------------------------------------------------------------------
// Fast control commands (Phase 1)
// ---------------------------------------------------------------------

/**
 * Resolve a fast control command instantly against the live store.
 * Returns an outcome when handled, or `null` to intentionally fall
 * through to the existing quick-shortcut gate (used for affirm/cancel
 * when a pending action exists — that gate already runs/clears it).
 *
 * The decision (what each command should do given current state) is the
 * pure `decideFastAction`; this function only executes the decision.
 */
async function handleFastCommand(fast: FastCommand, deps: AgentCommandDeps): Promise<AgentCommandOutcome | null> {
  const store = useEditorStore.getState();

  const refreshStatus = () => {
    const n = useEditorStore.getState().highlights.length;
    deps.setStatus(n > 0 ? "ready" : "idle", n > 0 ? "Ready to render" : undefined);
    deps.setProgress(n > 0 ? 1 : 0);
  };

  const action = decideFastAction(fast.kind, {
    pendingExecution: store.pendingExecution,
    pendingClarify: !!store.pendingClarify,
    highlightCount: store.highlights.length,
    hasRenderedBlob: !!store.renderedBlob
  });

  switch (action) {
    case "delegate":
      // affirm/cancel WITH a pending action → existing quick-shortcut gate.
      return null;

    case "undo": {
      const r = store.undoTimeline();
      deps.pushMessage({
        role: "assistant",
        content: r.restored
          ? 'Undone — restored the previous timeline. Say "redo" to reapply.'
          : "Nothing to undo yet.",
        attachment: { mode: "agent", kind: "undo" }
      });
      refreshStatus();
      return { handled: true };
    }

    case "redo": {
      const r = store.redoTimeline();
      deps.pushMessage({
        role: "assistant",
        content: r.restored ? "Redone — reapplied that change." : "Nothing to redo.",
        attachment: { mode: "agent", kind: "redo" }
      });
      refreshStatus();
      return { handled: true };
    }

    case "render_empty":
      deps.pushMessage({
        role: "assistant",
        content: "Add at least one clip to the timeline first, then I can render.",
        attachment: { mode: "agent", kind: "render" }
      });
      return { handled: true };

    case "render": {
      if (deps.onRender) {
        deps.pushMessage({ role: "assistant", content: "Rendering the timeline now\u2026", attachment: { mode: "agent", kind: "render" } });
        deps.onRender();
        return { handled: true };
      }
      deps.pushMessage({ role: "assistant", content: 'Tap "Render" to assemble the timeline into a video.', attachment: { mode: "agent", kind: "render" } });
      return { handled: true };
    }

    case "export_no_render":
      deps.pushMessage({
        role: "assistant",
        content: "There\u2019s no rendered short yet. Say \u201crender\u201d first, then \u201cexport\u201d to download it.",
        attachment: { mode: "agent", kind: "export" }
      });
      return { handled: true };

    case "export": {
      if (deps.onExport) {
        const r = await deps.onExport();
        deps.pushMessage({ role: "assistant", content: r.message, attachment: { mode: "agent", kind: "export" } });
        return { handled: true };
      }
      deps.pushMessage({
        role: "assistant",
        content: 'Tap "Export" under the preview to download the rendered short.',
        attachment: { mode: "agent", kind: "export" }
      });
      return { handled: true };
    }

    case "nudge_affirm":
      deps.pushMessage({
        role: "assistant",
        content:
          'There\u2019s nothing queued to confirm yet. Tell me what to do \u2014 e.g. "add first 5 seconds", "pick best parts", or "render".',
        attachment: { mode: "agent", kind: "affirm" }
      });
      return { handled: true };

    case "nudge_cancel":
      deps.pushMessage({ role: "assistant", content: "Nothing to cancel right now.", attachment: { mode: "agent", kind: "cancel" } });
      return { handled: true };

    default:
      return null;
  }
}

// ---------------------------------------------------------------------
// Transition commands (PR 59)
// ---------------------------------------------------------------------

/** Apply a parsed transition command to the store and report what changed
 *  + why. Offline + deterministic. */
function handleTransitionCommand(cmd: TransitionCommand, deps: AgentCommandDeps): AgentCommandOutcome {
  const store = useEditorStore.getState();
  const clipCount = store.highlights.length;

  if (clipCount < 2) {
    deps.pushMessage({
      role: "assistant",
      content: "Transitions need at least 2 clips on the timeline. Add another clip first.",
      attachment: { mode: "agent", kind: "transition" }
    });
    return { handled: true };
  }

  if (cmd.kind === "auto_all") {
    store.resetAutoTransitions();
  } else if (cmd.kind === "set_all") {
    const mapped = mapTransition(cmd.type);
    const next: BoundaryTransition[] = [];
    for (let i = 1; i < clipCount; i++) {
      next.push({
        index: i,
        type: cmd.type,
        mode: "manual",
        durationSeconds: normalizeTransitionDuration(undefined),
        reason: cmd.styleReason ?? `set to ${mapped.label.toLowerCase()}`,
        render: mapped.render,
        exact: mapped.exact,
        note: mapped.note
      });
    }
    store.setBoundaryTransitions(next);
  } else if (cmd.kind === "set_between") {
    // boundary index between clip A (1-based) and clip A+1 is `clipA`.
    if (store.boundaryTransitions.length === 0) store.recomputeAutoTransitions();
    const boundaryIndex = cmd.clipA;
    useEditorStore.getState().updateBoundaryTransition(boundaryIndex, {
      type: cmd.type,
      mode: "manual",
      reason: "set by you"
    });
  }

  const summary = summarizeBoundaries(deps, cmd);
  deps.pushMessage({ role: "assistant", content: summary, attachment: { mode: "agent", kind: "transition" } });
  return { handled: true };
}

/** Build a per-boundary chat summary ("1→2 Cut — same source…"). */
function summarizeBoundaries(deps: AgentCommandDeps, cmd: TransitionCommand): string {
  void deps;
  const bts = useEditorStore.getState().boundaryTransitions;
  if (bts.length === 0) return "No transitions to set yet.";

  const header =
    cmd.kind === "auto_all"
      ? `Auto-picked transitions for ${bts.length} boundar${bts.length === 1 ? "y" : "ies"}:`
      : cmd.kind === "set_all"
        ? `Set all ${bts.length} transition${bts.length === 1 ? "" : "s"}:`
        : `Updated the transition:`;

  const lines = [...bts]
    .sort((a, b) => a.index - b.index)
    .map((b) => {
      const label = mapTransition(b.type).label;
      const clipA = b.index; // boundary i is between clip i and i+1 (1-based)
      const clipB = b.index + 1;
      const reason = b.reason ? ` — ${b.reason}` : "";
      const mapped = !b.exact && b.note ? ` (${b.note})` : "";
      return `${clipA}→${clipB} ${label}${reason}${mapped}`;
    });

  return [header, ...lines].join("\n");
}

interface ApplyResult {
  anyChange: boolean;
}

function applyOps(ops: ResolvedOp[], memory: AgentMemoryStore, deps: AgentCommandDeps): ApplyResult {
  const store = useEditorStore.getState();
  let anyChange = false;
  const createdClipIds: string[] = [];

  for (const op of ops) {
    const current: Highlight[] = useEditorStore.getState().highlights;
    switch (op.type) {
      case "add_clips": {
        const r = addClips(current, op.clips, op.placementIndex);
        if (r.changed > 0) {
          useEditorStore.getState().setHighlights(r.highlights);
          createdClipIds.push(...r.createdClipIds);
          anyChange = true;
        }
        break;
      }
      case "add_clip_ref": {
        const r = addClipRef(current, op.clipId, op.placementIndex);
        if (r.changed > 0) {
          useEditorStore.getState().setHighlights(r.highlights);
          createdClipIds.push(...r.createdClipIds);
          anyChange = true;
        }
        break;
      }
      case "move_clip": {
        const r = moveClip(current, op.clipId, op.placementIndex);
        if (r.changed > 0) {
          useEditorStore.getState().setHighlights(r.highlights);
          anyChange = true;
        }
        break;
      }
      case "remove_clip": {
        const r = removeClip(current, op.clipId);
        if (r.changed > 0) {
          useEditorStore.getState().setHighlights(r.highlights);
          anyChange = true;
        }
        break;
      }
      case "replace_clip": {
        const r = replaceClip(current, op.targetId, op.replacement);
        if (r.changed > 0) {
          useEditorStore.getState().setHighlights(r.highlights);
          createdClipIds.push(...r.createdClipIds);
          anyChange = true;
        }
        break;
      }
      case "extend_clip": {
        const r = extendClip(current, op.clipId, { beforeSeconds: op.beforeSeconds, afterSeconds: op.afterSeconds, sourceDuration: op.sourceDuration });
        if (r.changed > 0) {
          useEditorStore.getState().setHighlights(r.highlights);
          anyChange = true;
        }
        break;
      }
      case "trim_clip": {
        const r = trimClip(current, op.clipId, op.start, op.end);
        if (r.changed > 0) {
          useEditorStore.getState().setHighlights(r.highlights);
          anyChange = true;
        } else if (r.note) {
          deps.pushMessage({ role: "assistant", content: r.note, attachment: { mode: "agent" } });
        }
        break;
      }
      case "render": {
        if (deps.onRender) deps.onRender();
        else deps.pushMessage({ role: "assistant", content: "Tap \"Render\" to assemble the timeline into a video.", attachment: { mode: "agent" } });
        anyChange = true;
        break;
      }
    }
  }

  // Record created clips into agent flow memory + select the first one.
  if (createdClipIds.length > 0) {
    memory.noteCreatedClips(createdClipIds);
    useEditorStore.getState().selectClip(createdClipIds[0]);
  }

  return { anyChange };
}

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

// ---- per-session agent memory --------------------------------------
const memoryBySession = new Map<string, AgentMemoryStore>();

export function getAgentMemory(sessionId: string): AgentMemoryStore {
  let m = memoryBySession.get(sessionId);
  if (!m) {
    m = new AgentMemoryStore();
    memoryBySession.set(sessionId, m);
  }
  return m;
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

/** Entry point called from the editor BEFORE the quick-shortcut gate. */
export async function tryAgentCommand(
  userText: string,
  deps: AgentCommandDeps
): Promise<AgentCommandOutcome> {
  const memory = getAgentMemory(deps.sessionId);
  const { ctx, getTranscript } = buildContext(memory);

  let decision: AgentDecision;
  try {
    decision = await orchestrate({ text: userText, ctx, memory, getTranscript });
  } catch (err) {
    deps.logSession.system("agent.command.failed", { message: (err as Error).message }, "Agent command path errored; falling through.");
    return { handled: false };
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

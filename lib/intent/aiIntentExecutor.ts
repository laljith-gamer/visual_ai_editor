// =====================================================================
// lib/intent/aiIntentExecutor.ts
//
// Converts a structured AIIntentResult into editor store mutations.
//
// This is the EXECUTION layer: the AI router classifies the intent,
// this module applies it. No regex, no keyword matching — just
// typed parameter destructuring and store calls.
//
// The executor is ADDITIVE: it returns { handled, message, ... } so
// the caller can push the assistant message and update status. It
// never reads raw user text — only the structured intent.
// =====================================================================

import type { AIIntentResult, AIAction } from "./aiIntentTypes";
import { useEditorStore } from "@/hooks/useEditorStore";

export interface ExecutorDeps {
  pushMessage: (msg: {
    role: "user" | "assistant";
    content: string;
    attachment?: Record<string, unknown>;
  }) => void;
  setStatus: (status: string, detail?: string) => void;
  setProgress: (n: number) => void;
  setPendingClarify: (q: {
    message: string;
    questions: Array<{
      id: string;
      prompt: string;
      suggestions: string[];
      kind: string;
    }>;
  } | null) => void;
  setActiveTargetSeconds: (s: number | null) => void;
  /** Optional render trigger. */
  onRender?: () => void;
  /** Optional export/download trigger. */
  onExport?: () => Promise<{ ok: boolean; message: string }>;
  logSession: {
    ai: (kind: string, payload: Record<string, unknown>, summary?: string) => void;
  };
}

export interface ExecutorOutcome {
  /** True when the executor fully handled the turn. */
  handled: boolean;
  /** True when the turn needs the visual pipeline (create_highlight, find_moment). */
  needsVisualPipeline?: boolean;
  /** Compiled prompt for the planner (when visual pipeline is needed). */
  compiledPrompt?: string;
  /** True when the timeline should be replaced (not appended to). */
  replaceTimeline?: boolean;
}

/**
 * Execute a classified AI intent against the editor store.
 *
 * Returns { handled: true } when the turn is fully resolved (message
 * pushed, store updated), or { handled: false } with optional
 * visual pipeline flags when the caller needs to run the scoring
 * pipeline (for create_highlight / find_moment).
 */
export function executeAIIntent(
  intent: AIIntentResult,
  deps: ExecutorDeps
): ExecutorOutcome {
  const action = intent.action;

  switch (action) {
    // ---- Control commands (instant, no AI needed) ----
    case "undo":
      return executeUndo(deps);
    case "redo":
      return executeRedo(deps);
    case "render":
      return executeRender(deps);
    case "export":
      return executeExport(deps);

    // ---- Conversation (no store mutation) ----
    case "chat":
      return executeChat(intent, deps);
    case "read_only_question":
      return executeReadOnly(intent, deps);
    case "describe_video":
      return executeDescribe(deps);
    case "clarify":
      return executeClarify(intent, deps);

    // ---- Pending action resolution ----
    case "confirm_pending":
      return executeConfirm(deps);
    case "cancel_pending":
      return executeCancel(deps);
    case "answer_question":
      return executeAnswer(intent, deps);

    // ---- Tool commands ----
    case "set_format":
      return executeSetFormat(intent, deps);
    case "select_source":
      return executeSelectSource(intent, deps);
    case "switch_source":
      return executeSwitchSource(intent, deps);

    // ---- Transitions ----
    case "set_transition":
    case "auto_transitions":
    case "remove_transitions":
      return executeTransition(intent, deps);

    // ---- Timeline mutations ----
    case "remove_clip":
      return executeRemoveClip(intent, deps);
    case "trim_to_target":
      return executeTrimToTarget(intent, deps);

    // ---- Visual pipeline needed ----
    case "create_highlight":
    case "find_moment":
    case "compose_montage":
    case "merge_videos":
      return executeVisualPipeline(intent, deps);

    // ---- Clip-level edits (needs orchestrator) ----
    case "add_clip":
    case "move_clip":
    case "trim_clip":
    case "extend_clip":
    case "replace_clip":
    case "split_clip":
    case "refine_timeline":
    case "scan_video":
      // These need the existing orchestrator/pipeline — pass through
      return { handled: false };

    // ---- Fallback ----
    case "passthrough":
    case "unavailable":
    default:
      return { handled: false };
  }
}

// ---- Individual executors ----

function executeUndo(deps: ExecutorDeps): ExecutorOutcome {
  const store = useEditorStore.getState();
  const r = store.undoTimeline();
  deps.pushMessage({
    role: "assistant",
    content: r.restored
      ? "Undone — restored the previous timeline."
      : "Nothing to undo yet.",
    attachment: { mode: "agent", kind: "undo" }
  });
  refreshStatus(deps);
  deps.logSession.ai("ai.control", { action: "undo" }, "Undo");
  return { handled: true };
}

function executeRedo(deps: ExecutorDeps): ExecutorOutcome {
  const store = useEditorStore.getState();
  const r = store.redoTimeline();
  deps.pushMessage({
    role: "assistant",
    content: r.restored ? "Redone — reapplied that change." : "Nothing to redo.",
    attachment: { mode: "agent", kind: "redo" }
  });
  refreshStatus(deps);
  deps.logSession.ai("ai.control", { action: "redo" }, "Redo");
  return { handled: true };
}

function executeRender(deps: ExecutorDeps): ExecutorOutcome {
  const store = useEditorStore.getState();
  if (store.highlights.length === 0) {
    deps.pushMessage({
      role: "assistant",
      content: "There are no clips on the timeline yet. Add some clips first, then I can render.",
      attachment: { mode: "agent", kind: "render_empty" }
    });
    return { handled: true };
  }
  if (deps.onRender) {
    deps.onRender();
    deps.pushMessage({
      role: "assistant",
      content: "Rendering your video now…",
      attachment: { mode: "agent", kind: "render" }
    });
  }
  deps.logSession.ai("ai.control", { action: "render" }, "Render");
  return { handled: true };
}

function executeExport(deps: ExecutorDeps): ExecutorOutcome {
  const store = useEditorStore.getState();
  if (!store.renderedBlob) {
    deps.pushMessage({
      role: "assistant",
      content: "Nothing rendered yet. Say \"render\" first, then I can export.",
      attachment: { mode: "agent", kind: "export_no_render" }
    });
    return { handled: true };
  }
  if (deps.onExport) {
    void deps.onExport().then((r) => {
      deps.pushMessage({
        role: "assistant",
        content: r.message,
        attachment: { mode: "agent", kind: "export" }
      });
    });
  }
  deps.logSession.ai("ai.control", { action: "export" }, "Export");
  return { handled: true };
}

function executeChat(intent: AIIntentResult, deps: ExecutorDeps): ExecutorOutcome {
  const reply = intent.chatReply || "I'm here to help you edit your video! Upload a video and tell me what kind of short you'd like to make.";
  deps.pushMessage({
    role: "assistant",
    content: reply,
    attachment: { mode: "chat" }
  });
  deps.logSession.ai("ai.chat", { action: "chat" }, reply.slice(0, 100));
  return { handled: true };
}

function executeReadOnly(intent: AIIntentResult, deps: ExecutorDeps): ExecutorOutcome {
  // The AI already understood this is a read-only question.
  // We provide a basic answer from state — or the AI's own reasoning.
  const store = useEditorStore.getState();
  const clipCount = store.highlights.length;
  const hasPlan = !!store.plan;

  let answer: string;
  if (intent.chatReply) {
    answer = intent.chatReply;
  } else if (clipCount > 0) {
    answer = `You currently have ${clipCount} clip${clipCount > 1 ? "s" : ""} on the timeline${hasPlan ? " based on your editing plan" : ""}. Ask me anything about the edit, or tell me what to change!`;
  } else {
    answer = "No edits have been applied yet. Upload a video and tell me what kind of short you'd like to make!";
  }

  deps.pushMessage({
    role: "assistant",
    content: answer,
    attachment: { mode: "meta", kind: "read_only" }
  });
  deps.logSession.ai("ai.read_only", { action: "read_only_question" }, answer.slice(0, 100));
  return { handled: true };
}

function executeDescribe(deps: ExecutorDeps): ExecutorOutcome {
  // Let the existing describe responder handle this — it needs video metadata
  // which we don't have in the intent. Return handled=false to fall through.
  // The caller's describe guard will catch it.
  return { handled: false };
}

function executeClarify(intent: AIIntentResult, deps: ExecutorDeps): ExecutorOutcome {
  const message = intent.clarifyMessage || "Could you tell me more about what you'd like to do?";
  const suggestions = intent.suggestions ?? [];

  deps.pushMessage({
    role: "assistant",
    content: message,
    attachment: { mode: "intake", field: "ai-clarify" }
  });
  deps.setPendingClarify({
    message,
    questions: [{
      id: "ai-clarify",
      prompt: message,
      suggestions,
      kind: suggestions.length > 0 ? "single-choice" : "free-text"
    }]
  });
  deps.logSession.ai("ai.clarify", { action: "clarify" }, message.slice(0, 100));
  return { handled: true };
}

function executeConfirm(deps: ExecutorDeps): ExecutorOutcome {
  // Let the existing pending-action handler deal with this
  // It's already wired in the editor page
  return { handled: false };
}

function executeCancel(deps: ExecutorDeps): ExecutorOutcome {
  const store = useEditorStore.getState();
  if (store.pendingClarify) {
    deps.setPendingClarify(null);
    deps.pushMessage({
      role: "assistant",
      content: "Cancelled. What would you like to do instead?",
      attachment: { mode: "agent", kind: "cancel" }
    });
    return { handled: true };
  }
  // Let the existing handler deal with pending execution cancels
  return { handled: false };
}

function executeAnswer(intent: AIIntentResult, deps: ExecutorDeps): ExecutorOutcome {
  // Answer to a pending question — the existing clarify resolver handles this
  return { handled: false };
}

function executeSetFormat(intent: AIIntentResult, deps: ExecutorDeps): ExecutorOutcome {
  const format = intent.format;
  if (!format) return { handled: false };

  const store = useEditorStore.getState();
  store.setOutputFormat(format);

  const label = format === "vertical" ? "vertical (9:16)"
    : format === "horizontal" ? "horizontal (16:9)"
    : "square (1:1)";

  deps.pushMessage({
    role: "assistant",
    content: `Output format set to ${label}.`,
    attachment: { mode: "agent", kind: "format", format }
  });
  deps.logSession.ai("ai.format", { action: "set_format", format }, `Format → ${format}`);
  return { handled: true };
}

function executeSelectSource(intent: AIIntentResult, deps: ExecutorDeps): ExecutorOutcome {
  const store = useEditorStore.getState();
  const ref = intent.sourceRef;

  if (!ref) return { handled: false };

  if (ref.type === "all") {
    store.selectAllSources();
    const allIds = store.sources.map((s) => s.id);
    deps.pushMessage({
      role: "assistant",
      content: `All ${allIds.length} videos are now selected for editing.`,
      attachment: { mode: "agent", kind: "select_source" }
    });
    deps.logSession.ai("ai.source", { action: "select_source", type: "all" }, "Selected all sources");
    return { handled: true };
  }

  if (ref.type === "index" && ref.index != null) {
    const idx = ref.index - 1; // AI returns 1-indexed
    const source = store.sources[idx];
    if (source) {
      store.setActiveSource(source.id);
      store.selectActiveOnlySource();
      deps.pushMessage({
        role: "assistant",
        content: `Now using only "${source.meta.name}" for editing.`,
        attachment: { mode: "agent", kind: "select_source" }
      });
      deps.logSession.ai("ai.source", { action: "select_source", index: ref.index }, `Selected source ${ref.index}`);
      return { handled: true };
    }
  }

  return { handled: false };
}

function executeSwitchSource(intent: AIIntentResult, deps: ExecutorDeps): ExecutorOutcome {
  const store = useEditorStore.getState();
  const ref = intent.sourceRef;

  if (!ref || ref.type !== "index" || ref.index == null) return { handled: false };

  const idx = ref.index - 1;
  const source = store.sources[idx];
  if (source) {
    store.setActiveSource(source.id);
    deps.pushMessage({
      role: "assistant",
      content: `Switched to "${source.meta.name}" in the preview.`,
      attachment: { mode: "agent", kind: "switch_source" }
    });
    deps.logSession.ai("ai.source", { action: "switch_source", index: ref.index }, `Switched to source ${ref.index}`);
    return { handled: true };
  }

  return { handled: false };
}

function executeTransition(intent: AIIntentResult, deps: ExecutorDeps): ExecutorOutcome {
  // Transitions need the existing transition infrastructure (mapTransition etc.)
  // For now, pass through to the existing handlers
  return { handled: false };
}

function executeRemoveClip(intent: AIIntentResult, deps: ExecutorDeps): ExecutorOutcome {
  const store = useEditorStore.getState();
  const clipRef = intent.clipRef;

  if (!clipRef) return { handled: false };

  let clipId: string | undefined;
  if (clipRef.type === "selected") {
    clipId = store.selectedClipId ?? undefined;
  } else if (clipRef.type === "first") {
    clipId = store.highlights[0]?.id;
  } else if (clipRef.type === "last") {
    clipId = store.highlights[store.highlights.length - 1]?.id;
  } else if (clipRef.type === "index" && clipRef.index != null) {
    const idx = clipRef.index - 1;
    clipId = store.highlights[idx]?.id;
  }

  if (!clipId) {
    deps.pushMessage({
      role: "assistant",
      content: "I couldn't find that clip. Which clip would you like to remove?",
      attachment: { mode: "agent", kind: "clarify" }
    });
    return { handled: true };
  }

  const newHighlights = store.highlights.filter((h) => h.id !== clipId);
  store.setHighlights(newHighlights);

  deps.pushMessage({
    role: "assistant",
    content: `Removed clip ${clipRef.index ?? (clipRef.type === "first" ? "1" : clipRef.type === "last" ? String(store.highlights.length) : "")} from the timeline.`,
    attachment: { mode: "agent", kind: "remove_clip" }
  });
  refreshStatus(deps);
  deps.logSession.ai("ai.edit", { action: "remove_clip", clipId }, "Removed clip");
  return { handled: true };
}

function executeTrimToTarget(intent: AIIntentResult, deps: ExecutorDeps): ExecutorOutcome {
  if (intent.durationSeconds) {
    deps.setActiveTargetSeconds(intent.durationSeconds);
  }
  // The actual trim-to-target logic needs the pipeline — pass through
  return { handled: false };
}

function executeVisualPipeline(intent: AIIntentResult, deps: ExecutorDeps): ExecutorOutcome {
  // These actions need the visual scoring pipeline.
  // Build a compiled prompt from the AI's understanding.
  const topics = intent.topics ?? [];
  const excludeTopics = intent.excludeTopics ?? [];
  const duration = intent.durationSeconds;

  // Carry duration to the active target
  if (duration) {
    deps.setActiveTargetSeconds(duration);
  }

  // Build a clean brief for the planner
  const parts: string[] = [];
  if (intent.action === "merge_videos") {
    parts.push("merge all selected videos");
  } else if (intent.action === "compose_montage") {
    parts.push("create a montage");
  } else if (intent.action === "find_moment") {
    parts.push("find the moment");
  } else {
    parts.push("create a highlight reel");
  }

  if (topics.length > 0) {
    parts.push(`of ${topics.join(", ")}`);
  }
  if (excludeTopics.length > 0) {
    parts.push(`without ${excludeTopics.join(", ")}`);
  }
  if (duration) {
    parts.push(`(${duration} seconds)`);
  }

  const compiledPrompt = intent.normalizedText || parts.join(" ");

  deps.logSession.ai("ai.visual", {
    action: intent.action,
    topics,
    excludeTopics,
    duration
  }, `Visual pipeline: ${compiledPrompt.slice(0, 100)}`);

  return {
    handled: false,
    needsVisualPipeline: true,
    compiledPrompt,
    replaceTimeline: intent.replaceTimeline ?? true
  };
}

// ---- Helpers ----

function refreshStatus(deps: ExecutorDeps): void {
  const n = useEditorStore.getState().highlights.length;
  deps.setStatus(n > 0 ? "ready" : "idle", n > 0 ? "Ready to render" : undefined);
  deps.setProgress(n > 0 ? 1 : 0);
}

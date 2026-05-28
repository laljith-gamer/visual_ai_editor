/**
 * v1.7.5 — Quick-shortcut dispatcher.
 *
 * Bridges the grammar-based matcher (lib/intent/quickMatch.ts) and the
 * editor's existing per-mode handlers. When a shortcut fires, this
 * function does the minimum work to apply the change — no cloud call,
 * no scoring pipeline — and pushes a chat message tagged with a
 * `shortcut` attachment so the UI can render the ⚡ pill.
 *
 * Returns true when a shortcut fired and was handled, false when
 * nothing matched and the caller should fall through to the cloud
 * planner.
 *
 * Why a separate module:
 *   - Keeps app/editor/page.tsx focused on layout + the cloud-mode
 *     dispatcher (already a 1700-line file).
 *   - Lets the dev tester page (app/_dev/intent-tester) reuse the
 *     dispatcher for "what would this turn do?" previews.
 *   - The function takes only callable handles (pushMessage, setStatus,
 *     etc.) so it has zero React / DOM dependencies of its own.
 */

import { newId } from "@/lib/util/id";
import { logUser } from "@/lib/log/recorders";
import { useEditorStore } from "@/hooks/useEditorStore";
import type { EditOperation, Highlight, JobStatus } from "@/lib/types";
import { quickMatch } from "./quickMatch";
import type {
  QuickMatch,
  QuickMatchContext,
  QuickMatchEdit,
  QuickMatchExtract,
  QuickMatchMerge,
  QuickMatchPromote
} from "./types";

/** The bag of editor-state setters the dispatcher needs. We pass them
 *  in rather than reading from the store for the side-effect calls,
 *  so the editor page keeps a single source of truth for which
 *  setters exist. */
export interface QuickShortcutDeps {
  pushMessage: (msg: {
    role: "user" | "assistant";
    content: string;
    attachment?: Record<string, unknown>;
  }) => void;
  setStatus: (status: JobStatus, detail?: string) => void;
  setProgress: (n: number) => void;
  setInferred: (chips: import("@/lib/types").InferredField[]) => void;
  setHighlights: (h: Highlight[]) => void;
  setPendingClarify: (q: null) => void;
  setPendingExecution: (b: boolean) => void;
  /** Called when an "affirm" shortcut fires while pendingExecution is true. */
  handleRunPipeline: () => void;
  logSession: {
    ai: (
      kind: string,
      payload: Record<string, unknown>,
      summary?: string,
      ms?: number
    ) => void;
    system: (
      kind: string,
      payload: Record<string, unknown>,
      summary?: string
    ) => void;
    user: (
      kind: string,
      payload: Record<string, unknown>,
      summary?: string
    ) => void;
  };
  sessionId: string;
}

/** Build a QuickMatchContext from the live editor store. */
function buildContext(): QuickMatchContext {
  const s = useEditorStore.getState();
  const lastBriefing = s.lastBriefing;
  const prev = [...s.messages].reverse().find((m) => m.role === "assistant");
  return {
    sources: s.sources.map((src) => ({
      id: src.id,
      meta: { name: src.meta.name, duration: src.meta.duration }
    })),
    selectedSourceIds: [...s.selectedSourceIds],
    highlights: s.highlights.map((h) => ({
      id: h.id,
      start: h.start,
      end: h.end,
      sourceId: h.sourceId,
      label: h.label
    })),
    selectedClipId: s.selectedClipId,
    lastBriefing: lastBriefing
      ? {
          sourceId: lastBriefing.sourceId,
          bestParts: lastBriefing.bestParts.map((p) => ({
            id: p.id,
            startSeconds: p.startSeconds,
            endSeconds: p.endSeconds,
            label: p.label
          }))
        }
      : null,
    pendingExecution: s.pendingExecution,
    pendingClarify: !!s.pendingClarify,
    prevAssistantText: prev?.content
  };
}

/** Top-level entry point. Tries to match a shortcut; if successful,
 *  applies it and returns true. Returns false on no match. */
export async function tryQuickShortcut(
  userText: string,
  deps: QuickShortcutDeps
): Promise<boolean> {
  const ctx = buildContext();
  const { match, candidates } = quickMatch(userText, ctx);

  if (!match) {
    // Log the miss with the runner-up so dev tester / activity log
    // surfaces near-miss patterns. Useful for tuning thresholds later.
    if (candidates.length > 0) {
      deps.logSession.system(
        "intent.shortcut.miss",
        {
          userText,
          runnerUp: {
            kind: candidates[0].kind,
            confidence: candidates[0].confidence,
            patternId: candidates[0].patternId
          }
        },
        `Shortcut near-miss: ${candidates[0].patternId} @ ${candidates[0].confidence.toFixed(2)}`
      );
    }
    return false;
  }

  // Activity log — every shortcut firing.
  logUser({
    sessionId: deps.sessionId,
    kind: "intent.shortcut",
    payload: {
      kind: match.kind,
      patternId: match.patternId,
      confidence: match.confidence,
      userText
    },
    summary: `Local shortcut: ${match.patternId} @ ${match.confidence.toFixed(2)}`
  });

  switch (match.kind) {
    case "merge":
      return await runMerge(match, deps);
    case "extract":
      return await runExtract(match, deps);
    case "edit":
      return await runEdit(match, deps);
    case "promote":
      return await runPromote(match, deps);
    case "affirm":
      return runAffirm(deps);
    case "cancel":
      return runCancel(deps);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------
// Per-kind handlers. Each returns true on successful dispatch. Each
// pushes ONE assistant message with the `shortcut` attachment so the
// UI knows to render the ⚡ pill.
// ---------------------------------------------------------------------

const SHORTCUT_ATTACHMENT = (patternId: string, confidence: number) => ({
  mode: "shortcut",
  patternId,
  confidence
});

async function runMerge(
  m: QuickMatchMerge,
  deps: QuickShortcutDeps
): Promise<boolean> {
  const store = useEditorStore.getState();
  const allSources = store.sources;
  if (allSources.length === 0) {
    deps.pushMessage({
      role: "assistant",
      content: "Upload at least one video first, then I can merge.",
      attachment: SHORTCUT_ATTACHMENT(m.patternId, m.confidence)
    });
    return true;
  }

  // Resolve sources: planner-named order → selected → all in library order.
  let chosen: typeof allSources;
  if (m.sourceIds && m.sourceIds.length > 0) {
    chosen = m.sourceIds
      .map((id) => allSources.find((s) => s.id === id))
      .filter((s): s is (typeof allSources)[number] => Boolean(s));
    if (chosen.length === 0) {
      chosen = allSources.filter((s) =>
        store.selectedSourceIds.includes(s.id)
      );
    }
  } else {
    chosen = allSources.filter((s) =>
      store.selectedSourceIds.includes(s.id)
    );
  }
  if (chosen.length === 0) chosen = allSources;

  const newHighlights = chosen.map((src, i) => ({
    id: newId("clip"),
    start: 0,
    end: roundTwo(src.meta.duration),
    score: 1,
    reason: "Full source merged as-is",
    label: src.meta.name,
    transition: i === 0 ? ("none" as const) : m.transition,
    confidence: "high" as const,
    sourceId: src.id
  }));

  if (m.op === "append") {
    useEditorStore.getState().mergeHighlights(newHighlights);
  } else {
    deps.setHighlights(newHighlights);
  }

  // Switch active source to the first merged source.
  const firstId = chosen[0]?.id;
  if (firstId && firstId !== store.activeSourceId) {
    useEditorStore.getState().setActiveSource(firstId);
  }

  const total = newHighlights.reduce(
    (acc, h) => acc + (h.end - h.start),
    0
  );
  const summary =
    chosen.length === 1
      ? `Merged "${chosen[0].meta.name}" as a ${total.toFixed(1)}s clip on the timeline. Tap "Render" to assemble.`
      : `Merged ${chosen.length} videos in order — ${total.toFixed(1)}s total. Tap "Render" to assemble.`;

  deps.pushMessage({
    role: "assistant",
    content: summary,
    attachment: SHORTCUT_ATTACHMENT(m.patternId, m.confidence)
  });
  deps.setStatus("ready", "Ready to render");
  deps.setProgress(1);
  return true;
}

async function runExtract(
  m: QuickMatchExtract,
  deps: QuickShortcutDeps
): Promise<boolean> {
  const store = useEditorStore.getState();
  const active =
    store.sources.find((s) => s.id === store.activeSourceId) ??
    (m.sourceId ? store.sources.find((s) => s.id === m.sourceId) : undefined) ??
    store.sources[0];

  if (!active) {
    deps.pushMessage({
      role: "assistant",
      content: "Upload a video first, then I can grab a slice.",
      attachment: SHORTCUT_ATTACHMENT(m.patternId, m.confidence)
    });
    return true;
  }

  const { buildExtractedHighlight } = await import("@/lib/pipeline/extract");
  const built = buildExtractedHighlight({
    range: m.range,
    videoDuration: active.meta.duration,
    transition: "none"
  });
  if (built.length === 0) {
    deps.pushMessage({
      role: "assistant",
      content:
        "That range doesn't fit inside the active video. Try a different start or end.",
      attachment: SHORTCUT_ATTACHMENT(m.patternId, m.confidence)
    });
    return true;
  }

  // Stamp the active source on the highlight so multi-source flows keep working.
  const tagged = built.map((h) => ({ ...h, sourceId: active.id }));
  deps.setHighlights(tagged);

  const dur = tagged[0].end - tagged[0].start;
  deps.pushMessage({
    role: "assistant",
    content: `Pulled ${dur.toFixed(1)}s from "${active.meta.name}". Tap "Render" to assemble.`,
    attachment: SHORTCUT_ATTACHMENT(m.patternId, m.confidence)
  });
  deps.setStatus("ready", "Ready to render");
  deps.setProgress(1);
  return true;
}

async function runEdit(
  m: QuickMatchEdit,
  deps: QuickShortcutDeps
): Promise<boolean> {
  const store = useEditorStore.getState();
  let totalChanged = 0;
  const originalActive = store.activeSourceId;

  for (const op of m.operations) {
    if (op.sourceId && op.sourceId !== useEditorStore.getState().activeSourceId) {
      const exists = useEditorStore
        .getState()
        .sources.some((s) => s.id === op.sourceId);
      if (exists) useEditorStore.getState().setActiveSource(op.sourceId);
    }
    const s = useEditorStore.getState();
    const result = applyEditOp(op, s);
    totalChanged += result.changed;
  }

  if (
    originalActive &&
    useEditorStore.getState().activeSourceId !== originalActive
  ) {
    useEditorStore.getState().setActiveSource(originalActive);
  }

  const stateAfter = useEditorStore.getState();
  const verbHint = m.operations[0]?.kind ?? "edit";
  const summary =
    totalChanged === 0
      ? `Couldn't find clips matching that edit on the timeline.`
      : `Applied ${m.operations.length} ${verbHint.replace(/_/g, " ")} (${totalChanged} clip change${totalChanged === 1 ? "" : "s"}).`;

  deps.pushMessage({
    role: "assistant",
    content: summary,
    attachment: SHORTCUT_ATTACHMENT(m.patternId, m.confidence)
  });
  deps.setStatus(
    stateAfter.highlights.length > 0 ? "ready" : "idle",
    undefined
  );
  return true;
}

function applyEditOp(
  op: EditOperation,
  store: ReturnType<typeof useEditorStore.getState>
): { changed: number } {
  switch (op.kind) {
    case "trim_first":
      return store.trimFirstSeconds(op.seconds);
    case "trim_last":
      return store.trimLastSeconds(op.seconds);
    case "keep_range":
      return store.keepRange(op.startSeconds, op.endSeconds);
    case "drop_range":
      return store.dropRange(op.startSeconds, op.endSeconds);
    case "split_at":
      return store.splitAtTime(op.timeSeconds);
    case "split_selected": {
      const sel = store.highlights.find((h) => h.id === store.selectedClipId);
      if (sel) {
        return store.splitAtTime(sel.start + (sel.end - sel.start) / 2);
      }
      return { changed: 0 };
    }
    case "reset_source":
      return store.resetActiveSourceClips();
    default:
      return { changed: 0 };
  }
}

async function runPromote(
  m: QuickMatchPromote,
  deps: QuickShortcutDeps
): Promise<boolean> {
  const store = useEditorStore.getState();
  if (!store.lastBriefing || store.lastBriefing.bestParts.length === 0) {
    deps.pushMessage({
      role: "assistant",
      content:
        "I don't have a recent briefing in scope to clip from. Ask me to describe the video first.",
      attachment: SHORTCUT_ATTACHMENT(m.patternId, m.confidence)
    });
    return true;
  }

  const result = useEditorStore.getState().promoteBriefingParts({
    partIds: m.partIds,
    targetSeconds: m.targetSeconds,
    op: m.op
  });

  if (result.added === 0) {
    deps.pushMessage({
      role: "assistant",
      content:
        "Couldn't promote any briefing parts \u2014 they may overlap clips already on the timeline.",
      attachment: SHORTCUT_ATTACHMENT(m.patternId, m.confidence)
    });
    return true;
  }

  const finalTimeline = useEditorStore.getState().highlights;
  const total = finalTimeline.reduce((acc, h) => acc + (h.end - h.start), 0);
  const opVerb = m.op === "replace" ? "Replaced" : "Added";
  deps.pushMessage({
    role: "assistant",
    content: `${opVerb} ${result.added} clip${result.added === 1 ? "" : "s"} from the briefing. Timeline is now ${finalTimeline.length} clip${finalTimeline.length === 1 ? "" : "s"}, ${total.toFixed(1)}s total.`,
    attachment: SHORTCUT_ATTACHMENT(m.patternId, m.confidence)
  });
  deps.setStatus("ready", undefined);
  deps.setProgress(1);
  return true;
}

function runAffirm(deps: QuickShortcutDeps): boolean {
  // The affirm matcher already verified pendingExecution is true.
  // Just kick the existing run-pipeline handler — it pushes its own
  // assistant messages, so we don't double-push here.
  deps.handleRunPipeline();
  // We still attach a tiny shortcut breadcrumb message-less log via
  // the activity stream (already done at the top of tryQuickShortcut).
  return true;
}

function runCancel(deps: QuickShortcutDeps): boolean {
  deps.setPendingClarify(null);
  deps.setPendingExecution(false);
  deps.pushMessage({
    role: "assistant",
    content: "Cancelled. Tell me what you'd like instead.",
    attachment: SHORTCUT_ATTACHMENT("cancel.basic", 0.92)
  });
  deps.setStatus("idle", undefined);
  deps.setProgress(0);
  return true;
}

function roundTwo(n: number): number {
  return Math.round(n * 100) / 100;
}

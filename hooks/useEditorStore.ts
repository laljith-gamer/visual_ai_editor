"use client";

import { create } from "zustand";
import type {
  BestPart,
  ChatMessage,
  ClarifyQuestion,
  EditPlan,
  Highlight,
  InferredField,
  IntentMode,
  JobStatus,
  PlanPatch,
  PersistedSourceManifest,
  RestoredSourcePlaceholder,
  Session,
  SessionMemory,
  UserTier,
  VideoSource,
  VideoSourceMeta,
  VideoSourceSummary
} from "@/lib/types";
import type { Transcript } from "@/lib/audio/types";
import type { BoundaryTransition } from "@/lib/transitions/types";
import type { NewClipInput } from "@/lib/timeline/operations";
import { trimHighlightsToTarget } from "@/lib/timeline/trimToTarget";
import { normalizeTransitionDuration } from "@/lib/transitions/types";
import { mapTransition } from "@/lib/transitions/map";
import { buildAutoBoundaryTransitions } from "@/lib/transitions/timeline";
import type { TransitionClip, TransitionContext } from "@/lib/transitions/features";
import { newId } from "@/lib/util/id";
import { GREETINGS, LIBRARY_LIMITS } from "@/lib/config";
import { mergePlan } from "@/lib/plan/merge";
import {
  deleteSession,
  listSessions,
  loadSession,
  saveSession
} from "@/lib/store/sessions";
import {
  buildRestoredProjectState,
  buildPersistManifests,
  resolveUploadIdentity,
  usedMissingSources as usedMissingSourcesPure,
  canRenderTimeline,
  briefingStillValid
} from "@/lib/store/projectRestore";

interface EditorState {
  // Active session
  sessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  // ----- v1.6.0 video library ----------------------------------------
  /** Every uploaded source held in memory for this session. */
  sources: VideoSource[];
  /** Which source plays in the preview pane and is the target of
   *  manual edits. */
  activeSourceId: string | null;
  /** Subset of source ids the next AI run is allowed to pull from. */
  selectedSourceIds: string[];

  /** v2.1 — Restored sources whose bytes aren't loaded yet. These keep the
   *  original source ids so the timeline still references them; the UI
   *  shows a "re-upload to restore" placeholder. They NEVER carry a blob or
   *  object URL. Populated by restoreSession; emptied as each is hydrated. */
  missingSources: RestoredSourcePlaceholder[];

  // ----- mirror fields kept in sync with the active source ----------
  // The pipeline + many components still read these directly. v1.6.0
  // keeps them as straight fields (not getters) so zustand's selector
  // change-detection works without any wrapping. setActiveSource +
  // addSource + removeSource keep them coherent.
  videoBlob: Blob | null;
  videoUrl: string | null;
  videoMeta?: Session["videoMeta"];
  videoHash?: string;

  // Plan + outputs
  plan: EditPlan | null;
  highlights: Highlight[];
  selectedClipId: string | null;

  /** v1.7.9 — One-step undo snapshot of the timeline. Captured by every
   *  destructive/append timeline mutation BEFORE it changes anything, so
   *  the user can always recover from a wipe or an unwanted add. `null`
   *  means "nothing to undo". */
  previousHighlights: Highlight[] | null;
  previousSelectedClipId: string | null;

  /** v2.0 — One-step REDO snapshot. Captured by `undoTimeline` (the
   *  pre-undo timeline) so a subsequent "redo" re-applies it. Cleared by
   *  any fresh timeline mutation (via `snapshot()`), so redo never
   *  re-applies a stale future after an unrelated edit. */
  redoHighlights: Highlight[] | null;
  redoSelectedClipId: string | null;

  /** v1.7.9 — How the NEXT pipeline run should join its results to the
   *  timeline. Set by the editor when a plan/moment turn is resolved (or
   *  deferred behind the "Run analysis" card) and read by runPipeline —
   *  this is what lets a deferred run remember whether it should append
   *  or replace. Defaults to "replace" (the historical behaviour for a
   *  first plan on an empty timeline). */
  pendingTimelineOp: "append" | "replace";

  // Conversation state (NEW in v1.1.0)
  mode: IntentMode | null;
  inferred: InferredField[];
  pendingClarify: { message: string; questions: ClarifyQuestion[] } | null;

  /** v2.2 — A detected same-source overlap conflict awaiting the user's
   *  explicit choice (skip / replace / keep both / trim). The incoming clip
   *  is parked here (NOT yet on the timeline) so it's never resolved
   *  silently or destructively. Cleared once resolved or abandoned. */
  pendingOverlap: {
    incoming: NewClipInput;
    placementIndex?: number;
    existingClipId: string;
    existingRange: { start: number; end: number };
    overlapSeconds: number;
  } | null;

  /** v2.3 — A concrete pending ACTION awaiting a yes/no ("…go ahead?").
   *  Unlike pendingClarify (free-form), this carries enough to APPLY the
   *  action on confirm, so "yes do it" never becomes a search. */
  pendingAction: {
    kind: "refilter";
    message: string;
    include: string[];
    exclude: string[];
    targetSeconds: number | null;
    scope?: "current_timeline" | "current_video";
  } | {
    /** New pipeline picks that all overlapped existing clips — offered as a
     *  one-tap REPLACE instead of a silent "nothing to add" dead-end. */
    kind: "swap_timeline";
    message: string;
    highlights: Highlight[];
  } | null;

  /** v2.3 — The ACTIVE target duration (seconds), independent of any stale
   *  plan. Latest explicit user duration wins; "trim to fit" reads this. */
  activeTargetSeconds: number | null;

  /** Output aspect override set by an explicit chat command ("make it
   *  vertical"), independent of any plan. The renderer prefers this over
   *  plan.format. Null = derive from the plan or the source's native aspect. */
  outputFormat: "vertical" | "horizontal" | "square" | null;

  /** v1.4.0 — user tier as classified by the LLM on the most recent
   *  agent turn. Drives adaptive selection in events.ts / highlights.ts
   *  / moment.ts. Defaults to "novice" so the wide-net behavior is in
   *  effect even before the first chat turn. */
  userTier: UserTier;

  /** v1.7.2 — Most recent briefing the assistant returned. The
   *  briefing's bestParts each carry a precise (sourceId, start, end)
   *  tuple that can be promoted directly to timeline clips without
   *  re-running vision. Cleared when the user starts a new chat or
   *  changes the active source. */
  lastBriefing: {
    /** Stable id matching the briefing message in chat. */
    id: string;
    sourceId: string;
    sourceName?: string;
    bestParts: BestPart[];
    ts: number;
  } | null;

  /** v1.7.3 — Local-ASR transcripts keyed by sha256(source bytes).
   *  Populated by the background transcription kicked off on /launch
   *  and any explicit Re-transcribe action. Empty on first mount; the
   *  IDB cache is loaded lazily by useTranscription when a consumer
   *  asks for a specific hash. */
  transcripts: Record<string, Transcript>;

  /** Plan exists but the analysis pipeline has NOT yet been executed.
   *  Set after a fresh plan or scenarios-changed refinement so the UI can
   *  show a "Run analysis" confirmation card before paying for the
   *  expensive frame analysis. v1.2.1+. */
  pendingExecution: boolean;

  // Chat + status
  messages: ChatMessage[];
  status: JobStatus;
  progress: number;
  statusDetail?: string;

  // Memory chips
  memory: SessionMemory;

  // History
  history: Session[];

  // Output
  renderedBlob: Blob | null;
  renderedUrl: string | null;

  // ----- actions: session lifecycle ---------------------------------
  newSession: () => void;

  // ----- actions: video library (v1.6.0) ----------------------------
  /** Add a source to the library. Returns the new VideoSource (or null
   *  if the library is at the cap or this hash is already present). */
  addSource: (
    blob: Blob,
    meta: VideoSourceMeta,
    hash: string
  ) => VideoSource | null;
  /** v2.1 — Reconnect a re-uploaded file to a restored project. If `hash`
   *  matches a missing placeholder, the existing source id is hydrated
   *  (blob + url attached, placeholder removed, active/selected state
   *  reconnected). Otherwise this behaves like addSource (a new source).
   *  Returns the resulting runtime source, or null if addSource is at cap. */
  hydrateRestoredSource: (
    blob: Blob,
    meta: VideoSourceMeta,
    hash: string
  ) => VideoSource | null;
  /** v2.1 — Missing placeholders the CURRENT timeline depends on (the
   *  videos the user must re-upload before this project can render). */
  usedMissingSources: () => RestoredSourcePlaceholder[];
  /** v2.1 — False when the timeline is empty or any clip references a
   *  source whose bytes aren't loaded. The render guard reads this. */
  canRenderCurrentTimeline: () => boolean;
  removeSource: (id: string) => void;
  setActiveSource: (id: string) => void;
  toggleSourceSelection: (id: string) => void;
  setSourceSelection: (ids: string[]) => void;
  selectAllSources: () => void;
  selectActiveOnlySource: () => void;
  /** Total bytes across the library. Used by the rail to surface a
   *  "library is getting full" hint. */
  libraryBytes: () => number;

  /** Single-video back-compat shim. Equivalent to addSource + setActive.
   *  Older callers (probeVideo path) still call this. */
  setVideo: (blob: Blob, meta: Session["videoMeta"], hash: string) => void;
  /** Wipe the entire library and dependent state (plan, highlights). */
  clearVideo: () => void;

  // ----- actions: plan / highlights ---------------------------------
  /** Replace the entire plan (fresh-plan path). */
  setPlan: (plan: EditPlan) => void;
  /** Apply a partial patch to the current plan. Returns the new plan. */
  applyPlanPatch: (patch: PlanPatch) => EditPlan | null;

  setHighlights: (h: Highlight[]) => void;
  /** v1.7.1 — Append new highlights to the existing timeline without
   *  replacing them. Used by append-style refinements ("add the
   *  celebration too") so previously-curated clips are preserved.
   *  Returns the number of clips that were actually added (some may
   *  be skipped due to overlap dedupe or hard caps).
   *
   *  v1.7.9 — `opts.allowOverlap` bypasses the same-source overlap
   *  dedupe. Set it for EXPLICIT, user-pinned adds (extract / merge /
   *  promote of an exact range) where the user asked for that precise
   *  clip and we must never silently drop it. Automatic plan/moment
   *  runs leave it false so near-duplicate auto-picks are still merged
   *  away. */
  mergeHighlights: (
    incoming: Highlight[],
    opts?: { allowOverlap?: boolean }
  ) => { added: number; skipped: number };
  /** v1.7.9 — Restore the timeline to the snapshot captured before the
   *  most recent mutation. Returns whether anything was restored. */
  undoTimeline: () => { restored: boolean };
  /** v2.0 — Re-apply the timeline that `undoTimeline` reverted. One-step;
   *  no-op when there's nothing to redo. */
  redoTimeline: () => { restored: boolean };
  /** v1.7.9 — Set how the next pipeline run joins its results. */
  setPendingTimelineOp: (op: "append" | "replace") => void;
  updateHighlight: (id: string, patch: Partial<Highlight>) => void;
  removeHighlight: (id: string) => void;
  selectClip: (id: string | null) => void;

  // ----- actions: per-boundary transitions (PR 59) ------------------
  /** Per-boundary transitions for the current timeline (render order).
   *  Boundary index `i` sits between clip `i-1` and clip `i`. */
  boundaryTransitions: BoundaryTransition[];
  /** Replace the whole transition set (used by the auto recompute). */
  setBoundaryTransitions: (transitions: BoundaryTransition[]) => void;
  /** Pin/patch ONE boundary (a manual override). Marks it mode "manual"
   *  unless the patch says otherwise; re-maps render/exact/note. */
  updateBoundaryTransition: (index: number, patch: Partial<BoundaryTransition>) => void;
  /** Drop all manual overrides and recompute every boundary as auto. */
  resetAutoTransitions: () => void;
  /** Recompute auto transitions from the current timeline, PRESERVING
   *  manual overrides whose boundary still exists. Safe to call after any
   *  add/move/remove/replace. Offline + deterministic; degrades when
   *  transcript/motion data is absent. */
  recomputeAutoTransitions: () => void;

  // ----- actions: manual edits (v1.6.0) -----------------------------
  /** Drop or shorten clips in [0, seconds) for the active source. */
  trimFirstSeconds: (seconds: number) => { changed: number };
  /** Drop or shorten clips in [duration−seconds, duration) for active. */
  trimLastSeconds: (seconds: number) => { changed: number };
  /** Replace active-source clips with one clip [start, end]. */
  keepRange: (start: number, end: number) => { changed: number };
  /** Drop or split clips overlapping [start, end] on the active source. */
  dropRange: (start: number, end: number) => { changed: number };
  /** Split the clip under `time` into two halves. Active source. */
  splitAtTime: (time: number) => { changed: number };
  /** Wipe highlights from the active source only (other sources kept). */
  resetActiveSourceClips: () => { changed: number };

  // ----- actions: chat / status / memory ---------------------------
  pushMessage: (m: Omit<ChatMessage, "id" | "timestamp">) => ChatMessage;

  setStatus: (s: JobStatus, detail?: string) => void;
  setProgress: (p: number) => void;
  setMemory: (patch: Partial<SessionMemory>) => void;
  setRendered: (blob: Blob | null) => void;

  /** Conversation-state setters (NEW). */
  setMode: (mode: IntentMode | null) => void;
  setInferred: (fields: InferredField[]) => void;
  setPendingClarify: (
    p: { message: string; questions: ClarifyQuestion[] } | null
  ) => void;
  setPendingExecution: (v: boolean) => void;
  /** v2.2 — Park / clear a pending overlap conflict. */
  setPendingOverlap: (p: EditorState["pendingOverlap"]) => void;
  /** v2.3 — Park / clear a concrete pending action ("…go ahead?"). */
  setPendingAction: (p: EditorState["pendingAction"]) => void;
  /** v2.3 — Set the active target duration (latest explicit wins). */
  setActiveTargetSeconds: (seconds: number | null) => void;
  /** Set (or clear) the output-aspect override from a chat command. */
  setOutputFormat: (format: "vertical" | "horizontal" | "square" | null) => void;
  /** v2.3 — Trim the timeline to fit a target duration (drops WHOLE clips,
   *  snapshots for undo). Returns what changed. */
  trimTimelineToTarget: (
    targetSeconds: number,
    strategy?: "strongest" | "order"
  ) => { changed: number; totalBefore: number; totalAfter: number; alreadyUnder: boolean };
  /** v1.4.0 — set after each agent turn that returned a tier. */
  setUserTier: (tier: UserTier) => void;

  /** v1.7.2 — Persist the most recent briefing so subsequent turns can
   *  promote its bestParts to the timeline. Pass `null` to clear. */
  setLastBriefing: (b: EditorState["lastBriefing"]) => void;

  /** v1.7.3 — Save a freshly-produced transcript for a source. Keyed
   *  by sourceHash so re-uploads of the same file find it. */
  setTranscript: (sourceHash: string, transcript: Transcript) => void;
  /** v1.7.3 — Clear a transcript (used by the Re-transcribe affordance). */
  clearTranscript: (sourceHash: string) => void;

  /** v1.7.2 — Convert briefing best parts into timeline highlights.
   *
   *  Reads the lastBriefing slot, optionally filters by partIds,
   *  optionally trims to fit a target duration, then either appends
   *  or replaces the timeline. Returns counts so the caller can
   *  surface a summary message in chat.
   *
   *  Why this is a store action and not a free function:
   *    - The conversion needs the active source's hash + url (to
   *      attach the right sourceId), which lives in the store.
   *    - The result feeds straight into mergeHighlights (also in the
   *      store), so colocation keeps the API tight. */
  promoteBriefingParts: (args: {
    partIds?: string[];
    targetSeconds?: number;
    op?: "append" | "replace";
  }) => { added: number; skipped: number; total: number };

  // History
  refreshHistory: () => Promise<void>;
  restoreSession: (id: string) => Promise<void>;
  removeSession: (id: string) => Promise<void>;
  persist: () => Promise<void>;
}

const emptyMemory: SessionMemory = { styles: [], keep: [], skip: [] };

/** v1.7.1 — Hard cap on the total number of highlights kept on the
 *  timeline. mergeHighlights skips incoming clips once the total
 *  reaches this number, preferring higher-scoring ones. ffmpeg.wasm's
 *  input-list limit + UX (a 24-clip reel is unwieldy in the timeline
 *  panel) both motivated this number. */
const MERGE_HIGHLIGHTS_CAP = 24;

function freshState() {
  return {
    sessionId: newId("sess"),
    title: "Untitled session",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sources: [] as VideoSource[],
    activeSourceId: null as string | null,
    selectedSourceIds: [] as string[],
    missingSources: [] as RestoredSourcePlaceholder[],
    videoBlob: null as Blob | null,
    videoUrl: null as string | null,
    videoMeta: undefined as Session["videoMeta"] | undefined,
    videoHash: undefined as string | undefined,
    plan: null as EditPlan | null,
    highlights: [] as Highlight[],
    selectedClipId: null as string | null,
    previousHighlights: null as Highlight[] | null,
    previousSelectedClipId: null as string | null,
    redoHighlights: null as Highlight[] | null,
    redoSelectedClipId: null as string | null,
    pendingTimelineOp: "replace" as "append" | "replace",
    boundaryTransitions: [] as BoundaryTransition[],
    mode: null as IntentMode | null,
    inferred: [] as InferredField[],
    pendingClarify: null as EditorState["pendingClarify"],
    pendingOverlap: null as EditorState["pendingOverlap"],
    pendingAction: null as EditorState["pendingAction"],
    activeTargetSeconds: null as number | null,
    outputFormat: null as "vertical" | "horizontal" | "square" | null,
    pendingExecution: false,
    userTier: "novice" as UserTier,
    lastBriefing: null as EditorState["lastBriefing"],
    transcripts: {} as Record<string, Transcript>,
    messages: [
      {
        id: newId("m"),
        role: "assistant" as const,
        content: GREETINGS.initial,
        timestamp: Date.now()
      }
    ],
    status: "idle" as JobStatus,
    progress: 0,
    statusDetail: undefined as string | undefined,
    memory: emptyMemory,
    renderedBlob: null as Blob | null,
    renderedUrl: null as string | null
  };
}

/** Memory derived from a plan — duration/format/styles/avoid carry forward
 *  silently across turns. */
function memoryFromPlan(prev: SessionMemory, plan: EditPlan): SessionMemory {
  return {
    ...prev,
    // v1.8.x — only persist a duration preference when the user actually
    // named one. For no-duration plans `targetShortSeconds` is just the
    // soft, non-enforced fallback (PLAN_DEFAULTS, e.g. 30) — persisting it
    // would resurface a phantom "30s preference" in the planner's memory
    // block on later turns. Keep the previous value (usually undefined).
    duration: plan.userSpecifiedDuration ? plan.targetShortSeconds : prev.duration,
    format: plan.format,
    styles: Array.from(new Set([...(prev.styles || []), ...plan.styles])).slice(0, 8),
    skip: Array.from(new Set([...(prev.skip || []), ...plan.avoid])).slice(0, 8)
  };
}

/** Compute a 16:9-style aspect string for display. */
function aspectLabel(width: number, height: number): string | undefined {
  if (!width || !height) return undefined;
  const r = width / height;
  if (Math.abs(r - 16 / 9) < 0.05) return "16:9";
  if (Math.abs(r - 9 / 16) < 0.05) return "9:16";
  if (Math.abs(r - 1) < 0.05) return "1:1";
  if (Math.abs(r - 4 / 3) < 0.05) return "4:3";
  if (Math.abs(r - 21 / 9) < 0.05) return "21:9";
  return r.toFixed(2);
}

/** Round a clip endpoint to 2 dp for stability across reads + render. */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** v1.7.9 — Capture the current timeline as a one-step undo snapshot.
 *  Spread into the `set(...)` of any timeline mutation so the previous
 *  state is always recoverable via undoTimeline(). */
/** Map store highlights to the decoupled TransitionClip shape the
 *  transition engine consumes. Motion/saliency aren't tracked per clip in
 *  the store yet, so they stay undefined → the auto picker degrades to
 *  source-continuity + transcript/label signals. */
function toTransitionClips(highlights: Highlight[]): TransitionClip[] {
  return highlights.map((h) => ({
    id: h.id,
    start: h.start,
    end: h.end,
    sourceId: h.sourceId,
    label: h.label
  }));
}

/** Build a transition context that reads the LOCAL transcript (when one
 *  exists for the clip's source) so topic overlap can inform auto picks.
 *  Fully offline; returns null text when no transcript is cached. */
function transcriptContext(s: {
  sources: VideoSource[];
  transcripts: Record<string, Transcript>;
}): TransitionContext {
  const hashById = new Map(s.sources.map((src) => [src.id, src.hash]));
  return {
    getTranscriptText: (clip) => {
      const hash = clip.sourceId ? hashById.get(clip.sourceId) : undefined;
      const t = hash ? s.transcripts[hash] : undefined;
      if (!t || t.segments.length === 0) return null;
      const text = t.segments
        .filter((seg) => seg.start < clip.end && seg.end > clip.start)
        .map((seg) => seg.text)
        .join(" ")
        .trim();
      return text || null;
    }
  };
}

function snapshot(s: {
  highlights: Highlight[];
  selectedClipId: string | null;
}): {
  previousHighlights: Highlight[];
  previousSelectedClipId: string | null;
  redoHighlights: null;
  redoSelectedClipId: null;
} {
  return {
    previousHighlights: s.highlights,
    previousSelectedClipId: s.selectedClipId,
    // Any fresh mutation invalidates a pending redo.
    redoHighlights: null,
    redoSelectedClipId: null
  };
}

export const useEditorStore = create<EditorState>()((set, get) => ({
  ...freshState(),
  history: [],

  newSession: () => {
    const cur = get();
    for (const s of cur.sources) URL.revokeObjectURL(s.url);
    if (cur.renderedUrl) URL.revokeObjectURL(cur.renderedUrl);
    set({ ...freshState() });
  },

  // ----- video library ---------------------------------------------
  addSource: (blob, meta, hash) => {
    const cur = get();
    // Cap by count and total bytes to keep tabs healthy on lower-end
    // hardware. Both limits are configurable in lib/config.ts.
    if (cur.sources.length >= LIBRARY_LIMITS.maxCount) return null;
    const totalBytes = cur.sources.reduce((acc, s) => acc + s.meta.size, 0);
    if (totalBytes + meta.size > LIBRARY_LIMITS.maxTotalBytes) return null;
    // De-dupe by hash so re-uploading the same file is a no-op.
    const existing = cur.sources.find((s) => s.hash === hash);
    if (existing) {
      set({ activeSourceId: existing.id });
      syncMirrorFields(set, existing);
      return existing;
    }
    const id = newId("src");
    const url = URL.createObjectURL(blob);
    const enrichedMeta: VideoSourceMeta = {
      ...meta,
      aspect: meta.aspect ?? aspectLabel(meta.width, meta.height)
    };
    const source: VideoSource = {
      id,
      hash,
      blob,
      url,
      meta: enrichedMeta,
      addedAt: Date.now()
    };
    const sources = [...cur.sources, source];
    const selectedSourceIds = Array.from(
      new Set([...cur.selectedSourceIds, id])
    );
    set({
      sources,
      activeSourceId: id,
      selectedSourceIds,
      title: cur.sources.length === 0 ? meta.name : cur.title,
      updatedAt: Date.now()
    });
    syncMirrorFields(set, source);
    return source;
  },

  hydrateRestoredSource: (blob, meta, hash) => {
    const cur = get();
    const decision = resolveUploadIdentity(cur.missingSources, hash);

    // No matching missing placeholder → behave like a normal upload. This
    // also covers the "user uploaded a different file" case: it is added as
    // a new source and never silently replaces a missing one.
    if (decision.kind === "new") {
      return get().addSource(blob, meta, hash);
    }

    // Hash matched a missing placeholder → reconnect to the ORIGINAL id so
    // the timeline's clips become playable/renderable again automatically.
    const ph = decision.placeholder;

    // Guard: if the same id somehow already hydrated, just activate it.
    const already = cur.sources.find((s) => s.id === ph.id);
    if (already) {
      const missingSources = cur.missingSources.filter((p) => p.id !== ph.id);
      set({ missingSources, updatedAt: Date.now() });
      return already;
    }

    const url = URL.createObjectURL(blob);
    const enrichedMeta: VideoSourceMeta = {
      ...meta,
      aspect: meta.aspect ?? aspectLabel(meta.width, meta.height)
    };
    const source: VideoSource = {
      id: ph.id,
      hash,
      blob,
      url,
      meta: enrichedMeta,
      addedAt: ph.addedAt
    };
    const sources = [...cur.sources, source];
    const missingSources = cur.missingSources.filter((p) => p.id !== ph.id);
    // Keep this source selected for AI if it was at save time; otherwise
    // ensure at least one source stays selected.
    const selectedSourceIds = cur.selectedSourceIds.includes(ph.id)
      ? cur.selectedSourceIds
      : cur.selectedSourceIds.length === 0
        ? [ph.id]
        : cur.selectedSourceIds;

    set({ sources, missingSources, selectedSourceIds, updatedAt: Date.now() });

    // Reconnect the preview if this was the active source (or nothing is
    // currently showing a hydrated source).
    const activeIsHydrated = cur.sources.some((s) => s.id === cur.activeSourceId);
    if (cur.activeSourceId === ph.id || !activeIsHydrated) {
      set({ activeSourceId: ph.id });
      syncMirrorFields(set, source);
    }
    return source;
  },

  usedMissingSources: () => {
    const s = get();
    const hydratedIds = new Set(s.sources.map((x) => x.id));
    return usedMissingSourcesPure(s.highlights, s.missingSources, hydratedIds);
  },

  canRenderCurrentTimeline: () => {
    const s = get();
    const hydratedIds = new Set(s.sources.map((x) => x.id));
    return canRenderTimeline(s.highlights, hydratedIds);
  },

  removeSource: (id) => {
    const cur = get();
    const target = cur.sources.find((s) => s.id === id);
    const placeholder = cur.missingSources.find((p) => p.id === id);
    // Nothing to remove.
    if (!target && !placeholder) return;
    if (target) URL.revokeObjectURL(target.url);
    const sources = cur.sources.filter((s) => s.id !== id);
    // v2.1 — an explicit delete also drops a missing placeholder for that
    // id. (Restoring missing state never calls removeSource, so a missing
    // source's clips are preserved until the user explicitly deletes it.)
    const missingSources = cur.missingSources.filter((p) => p.id !== id);
    const selectedSourceIds = cur.selectedSourceIds.filter((x) => x !== id);
    // Drop highlights that came from this source so we never render
    // against a missing input.
    const highlights = cur.highlights.filter((h) => h.sourceId !== id);
    let activeSourceId = cur.activeSourceId;
    if (activeSourceId === id) {
      activeSourceId = sources[0]?.id ?? null;
    }
    set({
      sources,
      missingSources,
      selectedSourceIds,
      activeSourceId,
      highlights,
      selectedClipId:
        cur.selectedClipId &&
        highlights.some((h) => h.id === cur.selectedClipId)
          ? cur.selectedClipId
          : highlights[0]?.id ?? null,
      updatedAt: Date.now()
    });
    const newActive = sources.find((s) => s.id === activeSourceId) ?? null;
    syncMirrorFields(set, newActive);
  },

  setActiveSource: (id) => {
    const cur = get();
    const target = cur.sources.find((s) => s.id === id);
    if (target) {
      set({ activeSourceId: id, updatedAt: Date.now() });
      syncMirrorFields(set, target);
      return;
    }
    // v2.1 — allow making a MISSING placeholder the active source so its
    // (placeholder) tab/clips can be inspected. The preview pane shows
    // nothing until the file is re-uploaded; mirror fields are cleared.
    const placeholder = cur.missingSources.find((p) => p.id === id);
    if (placeholder) {
      set({ activeSourceId: id, updatedAt: Date.now() });
      syncMirrorFields(set, null);
    }
  },

  toggleSourceSelection: (id) => {
    const cur = get();
    if (!cur.sources.some((s) => s.id === id)) return;
    const has = cur.selectedSourceIds.includes(id);
    const next = has
      ? cur.selectedSourceIds.filter((x) => x !== id)
      : [...cur.selectedSourceIds, id];
    // We always keep at least one selected source if any exist — having
    // nothing selected makes the planner UI confusing.
    if (next.length === 0 && cur.sources.length > 0) {
      next.push(cur.activeSourceId ?? cur.sources[0].id);
    }
    set({ selectedSourceIds: next, updatedAt: Date.now() });
  },

  setSourceSelection: (ids) => {
    const cur = get();
    const valid = new Set(cur.sources.map((s) => s.id));
    const filtered = ids.filter((x) => valid.has(x));
    set({
      selectedSourceIds:
        filtered.length === 0 && cur.sources.length > 0
          ? [cur.activeSourceId ?? cur.sources[0].id]
          : filtered,
      updatedAt: Date.now()
    });
  },

  selectAllSources: () =>
    set((s) => ({
      selectedSourceIds: s.sources.map((x) => x.id),
      updatedAt: Date.now()
    })),

  selectActiveOnlySource: () =>
    set((s) => ({
      selectedSourceIds: s.activeSourceId ? [s.activeSourceId] : [],
      updatedAt: Date.now()
    })),

  libraryBytes: () =>
    get().sources.reduce((acc, s) => acc + s.meta.size, 0),

  // Single-video back-compat — used by the original ProjectRail upload
  // path. Adds a source if absent, sets it active.
  setVideo: (blob, meta, hash) => {
    if (!meta) return;
    get().addSource(blob, meta, hash);
  },

  clearVideo: () => {
    const cur = get();
    for (const s of cur.sources) URL.revokeObjectURL(s.url);
    if (cur.renderedUrl) URL.revokeObjectURL(cur.renderedUrl);
    set({
      sources: [],
      activeSourceId: null,
      selectedSourceIds: [],
      missingSources: [],
      videoBlob: null,
      videoUrl: null,
      videoMeta: undefined,
      videoHash: undefined,
      highlights: [],
      previousHighlights: null,
      previousSelectedClipId: null,
      pendingTimelineOp: "replace",
      plan: null,
      mode: null,
      inferred: [],
      pendingClarify: null,
      pendingOverlap: null,
      pendingAction: null,
      activeTargetSeconds: null,
      outputFormat: null,
      pendingExecution: false,
      renderedBlob: null,
      renderedUrl: null,
      progress: 0,
      status: "idle"
    });
  },

  // ----- plan / highlights -----------------------------------------
  setPlan: (plan) =>
    set((s) => ({
      plan,
      memory: memoryFromPlan(s.memory, plan),
      pendingClarify: null,
      updatedAt: Date.now()
    })),

  applyPlanPatch: (patch) => {
    const s = get();
    if (!s.plan) return null;
    const merged = mergePlan(s.plan, patch);
    set({
      plan: merged,
      memory: memoryFromPlan(s.memory, merged),
      pendingClarify: null,
      updatedAt: Date.now()
    });
    return merged;
  },

  setHighlights: (highlights) =>
    set((s) => ({
      ...snapshot(s),
      highlights,
      selectedClipId: highlights[0]?.id ?? null,
      updatedAt: Date.now()
    })),

  /** v1.7.1 — Merge new highlights into the existing timeline.
   *
   *  Policy:
   *    - Overlap dedupe: an incoming clip is dropped if it overlaps
   *      an existing one on the SAME source by more than 50% of its
   *      duration. Cross-source clips never overlap-dedupe.
   *    - Hard cap: total clip count is capped at MERGE_HIGHLIGHTS_CAP
   *      so unbounded appends don't break ffmpeg.wasm input lists.
   *      When the cap is reached, lower-scoring incoming clips are
   *      dropped first.
   *    - Sort: the merged array is re-sorted by source id then start
   *      time, matching mergeAcrossSources' "chronological chapters
   *      per source" convention.
   *    - Selection: existing selection survives the merge unless it
   *      gets evicted; in that case we fall back to the first clip.
   */
  mergeHighlights: (incoming, opts) => {
    if (!Array.isArray(incoming) || incoming.length === 0) {
      return { added: 0, skipped: 0 };
    }
    const allowOverlap = opts?.allowOverlap === true;
    const cur = get();
    const existing = cur.highlights;

    // Score-rank the incoming first so the cap-eviction step keeps the
    // best candidates if we're already near the limit.
    const incomingRanked = [...incoming].sort((a, b) => b.score - a.score);

    const merged: Highlight[] = [...existing];
    let added = 0;
    let skipped = 0;
    for (const h of incomingRanked) {
      // Cap reached — bail before adding more.
      if (merged.length >= MERGE_HIGHLIGHTS_CAP) {
        skipped += 1;
        continue;
      }
      // Overlap dedupe vs same-source clips already in the timeline.
      // v1.7.9 — skipped entirely when allowOverlap is set, which is the
      // case for explicit user-pinned adds (extract / merge / promote of
      // a named range). The user asked for that exact clip, so we must
      // never silently drop it just because it sits over an existing one.
      if (!allowOverlap) {
        const dur = Math.max(0.001, h.end - h.start);
        const conflict = merged.find((x) => {
          if ((x.sourceId ?? null) !== (h.sourceId ?? null)) return false;
          const o = Math.max(0, Math.min(x.end, h.end) - Math.max(x.start, h.start));
          return o / dur > 0.5;
        });
        if (conflict) {
          skipped += 1;
          continue;
        }
      }
      merged.push(h);
      added += 1;
    }

    // Stable sort: by sourceId (groups multi-source chapters) then by
    // start time within the source.
    merged.sort((a, b) => {
      const sa = a.sourceId ?? "";
      const sb = b.sourceId ?? "";
      if (sa !== sb) return sa.localeCompare(sb);
      return a.start - b.start;
    });

    // Preserve existing selection if it's still in the merged set;
    // otherwise pick the first clip so the preview pane has something.
    const selectedStillThere =
      cur.selectedClipId &&
      merged.some((x) => x.id === cur.selectedClipId);
    set({
      ...snapshot(cur),
      highlights: merged,
      selectedClipId: selectedStillThere ? cur.selectedClipId : merged[0]?.id ?? null,
      updatedAt: Date.now()
    });
    return { added, skipped };
  },

  undoTimeline: () => {
    const s = get();
    if (s.previousHighlights === null) return { restored: false };
    const restored = s.previousHighlights;
    const selId =
      s.previousSelectedClipId &&
      restored.some((h) => h.id === s.previousSelectedClipId)
        ? s.previousSelectedClipId
        : restored[0]?.id ?? null;
    set({
      highlights: restored,
      selectedClipId: selId,
      // One-step undo: clear the snapshot so a second "undo" is a no-op
      // rather than toggling back and forth unpredictably.
      previousHighlights: null,
      previousSelectedClipId: null,
      // Stash the pre-undo timeline so "redo" can re-apply it.
      redoHighlights: s.highlights,
      redoSelectedClipId: s.selectedClipId,
      updatedAt: Date.now()
    });
    return { restored: true };
  },

  redoTimeline: () => {
    const s = get();
    if (s.redoHighlights === null) return { restored: false };
    const restored = s.redoHighlights;
    const selId =
      s.redoSelectedClipId &&
      restored.some((h) => h.id === s.redoSelectedClipId)
        ? s.redoSelectedClipId
        : restored[0]?.id ?? null;
    set({
      highlights: restored,
      selectedClipId: selId,
      // Re-arm undo so the user can toggle back, and consume the redo slot.
      previousHighlights: s.highlights,
      previousSelectedClipId: s.selectedClipId,
      redoHighlights: null,
      redoSelectedClipId: null,
      updatedAt: Date.now()
    });
    return { restored: true };
  },

  setPendingTimelineOp: (op) => set({ pendingTimelineOp: op }),

  updateHighlight: (id, patch) =>
    set((s) => ({
      highlights: s.highlights.map((h) => (h.id === id ? { ...h, ...patch } : h)),
      updatedAt: Date.now()
    })),

  removeHighlight: (id) =>
    set((s) => ({
      ...snapshot(s),
      highlights: s.highlights.filter((h) => h.id !== id),
      selectedClipId: s.selectedClipId === id ? null : s.selectedClipId,
      updatedAt: Date.now()
    })),

  // ----- per-boundary transitions (PR 59) --------------------------
  setBoundaryTransitions: (transitions) =>
    set({ boundaryTransitions: transitions, updatedAt: Date.now() }),

  updateBoundaryTransition: (index, patch) =>
    set((s) => {
      const type = patch.type;
      const next = s.boundaryTransitions.map((bt) => {
        if (bt.index !== index) return bt;
        const merged: BoundaryTransition = {
          ...bt,
          ...patch,
          index,
          // An explicit edit is a manual override unless caller says auto.
          mode: patch.mode ?? "manual"
        };
        if (type) {
          const mapped = mapTransition(type);
          merged.render = mapped.render;
          merged.exact = mapped.exact;
          merged.note = mapped.note;
        }
        merged.durationSeconds = normalizeTransitionDuration(merged.durationSeconds);
        return merged;
      });
      return { boundaryTransitions: next, updatedAt: Date.now() };
    }),

  resetAutoTransitions: () => {
    const s = get();
    set({
      boundaryTransitions: buildAutoBoundaryTransitions(
        toTransitionClips(s.highlights),
        { context: transcriptContext(s) } // no `existing` → all auto
      ),
      updatedAt: Date.now()
    });
  },

  recomputeAutoTransitions: () => {
    const s = get();
    set({
      boundaryTransitions: buildAutoBoundaryTransitions(
        toTransitionClips(s.highlights),
        { context: transcriptContext(s), existing: s.boundaryTransitions }
      ),
      updatedAt: Date.now()
    });
  },

  selectClip: (id) => set({ selectedClipId: id }),

  // ----- manual edits ----------------------------------------------
  // Each primitive operates on the ACTIVE source only. The user can
  // switch the active source and tinker each one independently, which
  // keeps the model consistent with the preview pane.
  trimFirstSeconds: (seconds) => {
    const s = get();
    const sid = s.activeSourceId;
    if (!sid || seconds <= 0) return { changed: 0 };
    let changed = 0;
    const out: Highlight[] = [];
    for (const h of s.highlights) {
      if (h.sourceId && h.sourceId !== sid) {
        out.push(h);
        continue;
      }
      if (h.end <= seconds) {
        // entirely inside the trim — drop.
        changed++;
        continue;
      }
      if (h.start < seconds) {
        out.push({ ...h, start: r2(seconds) });
        changed++;
        continue;
      }
      out.push(h);
    }
    set({ ...snapshot(s), highlights: out, updatedAt: Date.now() });
    return { changed };
  },

  trimLastSeconds: (seconds) => {
    const s = get();
    const sid = s.activeSourceId;
    if (!sid || seconds <= 0) return { changed: 0 };
    const dur =
      s.sources.find((x) => x.id === sid)?.meta.duration ??
      s.videoMeta?.duration ??
      0;
    if (dur <= 0) return { changed: 0 };
    const cutoff = dur - seconds;
    let changed = 0;
    const out: Highlight[] = [];
    for (const h of s.highlights) {
      if (h.sourceId && h.sourceId !== sid) {
        out.push(h);
        continue;
      }
      if (h.start >= cutoff) {
        changed++;
        continue;
      }
      if (h.end > cutoff) {
        out.push({ ...h, end: r2(cutoff) });
        changed++;
        continue;
      }
      out.push(h);
    }
    set({ ...snapshot(s), highlights: out, updatedAt: Date.now() });
    return { changed };
  },

  keepRange: (start, end) => {
    const s = get();
    const sid = s.activeSourceId;
    if (!sid || end <= start) return { changed: 0 };
    const dur =
      s.sources.find((x) => x.id === sid)?.meta.duration ??
      s.videoMeta?.duration ??
      0;
    const a = Math.max(0, r2(start));
    const b = Math.min(dur || end, r2(end));
    if (b <= a) return { changed: 0 };
    const otherSources = s.highlights.filter(
      (h) => h.sourceId && h.sourceId !== sid
    );
    const removed = s.highlights.length - otherSources.length;
    const newClip: Highlight = {
      id: newId("clip"),
      start: a,
      end: b,
      score: 1,
      reason: `Kept ${a.toFixed(1)}s \u2013 ${b.toFixed(1)}s`,
      transition: "none",
      confidence: "high",
      sourceId: sid
    };
    const next = [...otherSources, newClip].sort((x, y) => x.start - y.start);
    set({
      ...snapshot(s),
      highlights: next,
      selectedClipId: newClip.id,
      updatedAt: Date.now()
    });
    return { changed: removed + 1 };
  },

  dropRange: (start, end) => {
    const s = get();
    const sid = s.activeSourceId;
    if (!sid || end <= start) return { changed: 0 };
    const a = Math.max(0, r2(start));
    const b = r2(end);
    if (b <= a) return { changed: 0 };
    let changed = 0;
    const out: Highlight[] = [];
    for (const h of s.highlights) {
      if (h.sourceId && h.sourceId !== sid) {
        out.push(h);
        continue;
      }
      // No overlap — keep.
      if (h.end <= a || h.start >= b) {
        out.push(h);
        continue;
      }
      // Fully inside drop — remove.
      if (h.start >= a && h.end <= b) {
        changed++;
        continue;
      }
      // Drop hits the left edge.
      if (h.start < a && h.end <= b) {
        out.push({ ...h, end: a });
        changed++;
        continue;
      }
      // Drop hits the right edge.
      if (h.start >= a && h.end > b) {
        out.push({ ...h, start: b });
        changed++;
        continue;
      }
      // Drop is in the middle — split into two clips.
      out.push({ ...h, end: a });
      out.push({
        ...h,
        id: newId("clip"),
        start: b
      });
      changed++;
    }
    // Filter out any clips that became too short after the split.
    const filtered = out.filter((h) => h.end - h.start >= 0.2);
    set({
      ...snapshot(s),
      highlights: filtered.sort((x, y) => x.start - y.start),
      updatedAt: Date.now()
    });
    return { changed };
  },

  splitAtTime: (time) => {
    const s = get();
    const sid = s.activeSourceId;
    if (!sid) return { changed: 0 };
    const t = r2(time);
    let changed = 0;
    const out: Highlight[] = [];
    for (const h of s.highlights) {
      if (h.sourceId && h.sourceId !== sid) {
        out.push(h);
        continue;
      }
      if (t > h.start + 0.2 && t < h.end - 0.2) {
        out.push({ ...h, end: t });
        out.push({ ...h, id: newId("clip"), start: t });
        changed++;
      } else {
        out.push(h);
      }
    }
    set({
      ...snapshot(s),
      highlights: out.sort((x, y) => x.start - y.start),
      updatedAt: Date.now()
    });
    return { changed };
  },

  resetActiveSourceClips: () => {
    const s = get();
    const sid = s.activeSourceId;
    if (!sid) return { changed: 0 };
    const before = s.highlights.length;
    const next = s.highlights.filter(
      (h) => h.sourceId && h.sourceId !== sid
    );
    set({
      ...snapshot(s),
      highlights: next,
      selectedClipId: next[0]?.id ?? null,
      updatedAt: Date.now()
    });
    return { changed: before - next.length };
  },

  // ----- chat / status ---------------------------------------------
  pushMessage: (m) => {
    const message: ChatMessage = {
      id: newId("m"),
      timestamp: Date.now(),
      ...m
    };
    set((s) => ({ messages: [...s.messages, message], updatedAt: Date.now() }));
    return message;
  },

  setStatus: (status, detail) => set({ status, statusDetail: detail }),
  setProgress: (progress) => set({ progress: Math.max(0, Math.min(1, progress)) }),

  setMemory: (patch) =>
    set((s) => ({ memory: { ...s.memory, ...patch }, updatedAt: Date.now() })),

  setRendered: (blob) => {
    const cur = get();
    if (cur.renderedUrl) URL.revokeObjectURL(cur.renderedUrl);
    if (!blob) {
      set({ renderedBlob: null, renderedUrl: null });
      return;
    }
    set({ renderedBlob: blob, renderedUrl: URL.createObjectURL(blob) });
  },

  setMode: (mode) => set({ mode }),
  setInferred: (fields) => set({ inferred: fields }),
  setPendingClarify: (p) => set({ pendingClarify: p }),
  setPendingExecution: (v) => set({ pendingExecution: v }),
  setPendingOverlap: (p) => set({ pendingOverlap: p }),
  setPendingAction: (p) => set({ pendingAction: p }),
  setActiveTargetSeconds: (seconds) => set({ activeTargetSeconds: seconds }),
  setOutputFormat: (outputFormat) => set({ outputFormat, updatedAt: Date.now() }),

  trimTimelineToTarget: (targetSeconds, strategy = "strongest") => {
    const s = get();
    const result = trimHighlightsToTarget(s.highlights, targetSeconds, { strategy });
    if (result.alreadyUnder || result.removedCount === 0) {
      return {
        changed: 0,
        totalBefore: result.totalBefore,
        totalAfter: result.totalAfter,
        alreadyUnder: result.alreadyUnder
      };
    }
    set({
      ...snapshot(s),
      highlights: result.kept,
      selectedClipId: result.kept.some((h) => h.id === s.selectedClipId)
        ? s.selectedClipId
        : result.kept[0]?.id ?? null,
      updatedAt: Date.now()
    });
    return {
      changed: result.removedCount,
      totalBefore: result.totalBefore,
      totalAfter: result.totalAfter,
      alreadyUnder: false
    };
  },
  setUserTier: (tier) => set({ userTier: tier }),

  setLastBriefing: (b) => set({ lastBriefing: b, updatedAt: Date.now() }),

  setTranscript: (sourceHash, transcript) =>
    set((s) => ({
      transcripts: { ...s.transcripts, [sourceHash]: transcript },
      updatedAt: Date.now()
    })),

  clearTranscript: (sourceHash) =>
    set((s) => {
      // Object-spread copy + delete keeps the slot reactive in
      // zustand subscribers that key on the whole transcripts dict.
      const next = { ...s.transcripts };
      delete next[sourceHash];
      return { transcripts: next, updatedAt: Date.now() };
    }),

  /** v1.7.2 — see EditorState.promoteBriefingParts docblock. */
  promoteBriefingParts: ({ partIds, targetSeconds, op }) => {
    const cur = get();
    const briefing = cur.lastBriefing;
    if (!briefing || briefing.bestParts.length === 0) {
      return { added: 0, skipped: 0, total: 0 };
    }
    // Filter by ids, preserving the briefing-order ranking. Empty/
    // undefined partIds = take everything in original order.
    const wanted = Array.isArray(partIds) && partIds.length > 0
      ? new Set(partIds)
      : null;
    let parts = briefing.bestParts.filter((p) =>
      wanted ? wanted.has(p.id) : true
    );

    // Optional target trim: keep the highest-ranked (earliest in the
    // briefing list — the briefing model returns by importance first)
    // until total seconds fit the budget. Each part is whatever its
    // own start/end says; we don't shrink individual parts here.
    if (typeof targetSeconds === "number" && targetSeconds > 0) {
      const trimmed: BestPart[] = [];
      let total = 0;
      for (const p of parts) {
        const dur = Math.max(0, p.endSeconds - p.startSeconds);
        if (total + dur <= targetSeconds * 1.05 || trimmed.length === 0) {
          trimmed.push(p);
          total += dur;
        }
        if (total >= targetSeconds) break;
      }
      parts = trimmed;
    }

    if (parts.length === 0) {
      return { added: 0, skipped: 0, total: 0 };
    }

    // Convert to highlights. Score 0.85 is high-but-not-max so the
    // confidence bucket reads "high" without overriding actual scored
    // clips that legitimately hit 0.95+.
    const newHighlights: Highlight[] = parts.map((p, i) => ({
      id: newId("clip"),
      start: r2(p.startSeconds),
      end: r2(p.endSeconds),
      score: 0.85,
      reason: p.why,
      label: p.label,
      transition: i === 0 ? "none" : (cur.plan?.transition ?? "fade"),
      confidence: "high",
      sourceId: briefing.sourceId
    }));

    if (op === "replace") {
      // Wipe the timeline first then add. setHighlights replaces +
      // resets selection.
      get().setHighlights(newHighlights);
      return {
        added: newHighlights.length,
        skipped: 0,
        total: newHighlights.length
      };
    }

    // Default: append via mergeHighlights so the existing timeline
    // (and its selection) survives.
    const result = get().mergeHighlights(newHighlights);
    return { ...result, total: newHighlights.length };
  },

  refreshHistory: async () => {
    const sessions = await listSessions();
    set({ history: sessions });
  },

  restoreSession: async (id) => {
    const s = await loadSession(id);
    if (!s) return;
    const cur = get();
    for (const x of cur.sources) URL.revokeObjectURL(x.url);
    if (cur.renderedUrl) URL.revokeObjectURL(cur.renderedUrl);

    // v2.1 — full project restore. Sources come back as MISSING
    // placeholders (no blobs — they can't survive a reload); the timeline
    // keeps referencing them by their original ids. Re-uploading a file
    // with a matching hash reconnects it (see hydrateRestoredSource).
    const restored = buildRestoredProjectState(s);
    const lastBriefing = briefingStillValid(s.lastBriefing, restored.manifests)
      ? s.lastBriefing ?? null
      : null;

    set({
      sessionId: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      sources: [],
      missingSources: restored.missingSources,
      activeSourceId: restored.activeSourceId,
      selectedSourceIds: restored.selectedSourceIds,
      // Mirror fields stay empty until the active source is re-uploaded.
      videoBlob: null,
      videoUrl: null,
      videoMeta: s.videoMeta,
      videoHash: s.videoHash,
      plan: s.plan ?? null,
      highlights: restored.highlights,
      selectedClipId: restored.selectedClipId,
      previousHighlights: null,
      previousSelectedClipId: null,
      redoHighlights: null,
      redoSelectedClipId: null,
      pendingTimelineOp: s.pendingTimelineOp ?? "replace",
      boundaryTransitions: s.boundaryTransitions ?? [],
      mode: s.mode ?? null,
      inferred: s.inferred ?? [],
      pendingClarify: null,
      pendingExecution: s.pendingExecution ?? false,
      userTier: s.userTier ?? "novice",
      lastBriefing,
      messages: s.messages,
      status: s.status,
      progress: s.progress,
      memory: s.memory,
      renderedBlob: null,
      renderedUrl: null
    });
  },

  removeSession: async (id) => {
    await deleteSession(id);
    await get().refreshHistory();
  },

  persist: async () => {
    const s = get();
    // v2.1 — full source manifest = hydrated (available) + still-missing
    // placeholders, so a partially-restored project never loses the
    // sources it still needs. No blobs are written.
    const sourceManifests: PersistedSourceManifest[] = buildPersistManifests(
      s.sources,
      s.missingSources
    );
    // Keep the legacy summary array for older readers (history count, etc).
    const sourcesSummary: VideoSourceSummary[] = sourceManifests.map((m) => ({
      id: m.id,
      hash: m.hash,
      meta: m.meta,
      addedAt: m.addedAt
    }));
    await saveSession({
      id: s.sessionId,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: Date.now(),
      schemaVersion: 2,
      videoMeta: s.videoMeta,
      videoHash: s.videoHash,
      sources: sourcesSummary.length > 0 ? sourcesSummary : undefined,
      sourceManifests: sourceManifests.length > 0 ? sourceManifests : undefined,
      selectedSourceIds:
        s.selectedSourceIds.length > 0 ? s.selectedSourceIds : undefined,
      activeSourceId: s.activeSourceId ?? undefined,
      plan: s.plan ?? undefined,
      memory: s.memory,
      highlights: s.highlights,
      selectedClipId: s.selectedClipId,
      boundaryTransitions:
        s.boundaryTransitions.length > 0 ? s.boundaryTransitions : undefined,
      pendingTimelineOp: s.pendingTimelineOp,
      pendingExecution: s.pendingExecution || undefined,
      messages: s.messages,
      status: s.status,
      progress: s.progress,
      mode: s.mode ?? undefined,
      inferred: s.inferred.length > 0 ? s.inferred : undefined,
      userTier: s.userTier,
      lastBriefing: s.lastBriefing ?? undefined
    });
    await s.refreshHistory();
  }
}));

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/** Keep the legacy single-video mirror fields in sync with the active
 *  source so the existing pipeline + components keep working unchanged. */
function syncMirrorFields(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  set: (partial: any) => void,
  source: VideoSource | null
) {
  if (!source) {
    set({
      videoBlob: null,
      videoUrl: null,
      videoMeta: undefined,
      videoHash: undefined
    });
    return;
  }
  set({
    videoBlob: source.blob,
    videoUrl: source.url,
    videoMeta: {
      name: source.meta.name,
      size: source.meta.size,
      duration: source.meta.duration,
      width: source.meta.width,
      height: source.meta.height
    },
    videoHash: source.hash
  });
}

/** Compare scenario id sets to decide whether the scoring cache is still valid. */
export function scenariosChanged(a: EditPlan | null, b: EditPlan | null): boolean {
  if (!a || !b) return true;
  if (a.scenarios.length !== b.scenarios.length) return true;
  const aIds = new Set(a.scenarios.map((s) => s.id));
  for (const s of b.scenarios) if (!aIds.has(s.id)) return true;
  if (a.sampleEverySeconds !== b.sampleEverySeconds) return true;
  if (a.inferenceWidth !== b.inferenceWidth) return true;
  return false;
}

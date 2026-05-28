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
  Session,
  SessionMemory,
  UserTier,
  VideoSource,
  VideoSourceMeta,
  VideoSourceSummary
} from "@/lib/types";
import { newId } from "@/lib/util/id";
import { GREETINGS, LIBRARY_LIMITS } from "@/lib/config";
import { mergePlan } from "@/lib/plan/merge";
import {
  deleteSession,
  listSessions,
  loadSession,
  saveSession
} from "@/lib/store/sessions";

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

  // Conversation state (NEW in v1.1.0)
  mode: IntentMode | null;
  inferred: InferredField[];
  pendingClarify: { message: string; questions: ClarifyQuestion[] } | null;

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
   *  be skipped due to overlap dedupe or hard caps). */
  mergeHighlights: (
    incoming: Highlight[]
  ) => { added: number; skipped: number };
  updateHighlight: (id: string, patch: Partial<Highlight>) => void;
  removeHighlight: (id: string) => void;
  selectClip: (id: string | null) => void;

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
  /** v1.4.0 — set after each agent turn that returned a tier. */
  setUserTier: (tier: UserTier) => void;

  /** v1.7.2 — Persist the most recent briefing so subsequent turns can
   *  promote its bestParts to the timeline. Pass `null` to clear. */
  setLastBriefing: (b: EditorState["lastBriefing"]) => void;

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
    videoBlob: null as Blob | null,
    videoUrl: null as string | null,
    videoMeta: undefined as Session["videoMeta"] | undefined,
    videoHash: undefined as string | undefined,
    plan: null as EditPlan | null,
    highlights: [] as Highlight[],
    selectedClipId: null as string | null,
    mode: null as IntentMode | null,
    inferred: [] as InferredField[],
    pendingClarify: null as EditorState["pendingClarify"],
    pendingExecution: false,
    userTier: "novice" as UserTier,
    lastBriefing: null as EditorState["lastBriefing"],
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
    duration: plan.targetShortSeconds,
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

  removeSource: (id) => {
    const cur = get();
    const target = cur.sources.find((s) => s.id === id);
    if (!target) return;
    URL.revokeObjectURL(target.url);
    const sources = cur.sources.filter((s) => s.id !== id);
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
    if (!target) return;
    set({ activeSourceId: id, updatedAt: Date.now() });
    syncMirrorFields(set, target);
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
      videoBlob: null,
      videoUrl: null,
      videoMeta: undefined,
      videoHash: undefined,
      highlights: [],
      plan: null,
      mode: null,
      inferred: [],
      pendingClarify: null,
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
    set({
      highlights,
      selectedClipId: highlights[0]?.id ?? null,
      updatedAt: Date.now()
    }),

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
  mergeHighlights: (incoming) => {
    if (!Array.isArray(incoming) || incoming.length === 0) {
      return { added: 0, skipped: 0 };
    }
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
      highlights: merged,
      selectedClipId: selectedStillThere ? cur.selectedClipId : merged[0]?.id ?? null,
      updatedAt: Date.now()
    });
    return { added, skipped };
  },

  updateHighlight: (id, patch) =>
    set((s) => ({
      highlights: s.highlights.map((h) => (h.id === id ? { ...h, ...patch } : h)),
      updatedAt: Date.now()
    })),

  removeHighlight: (id) =>
    set((s) => ({
      highlights: s.highlights.filter((h) => h.id !== id),
      selectedClipId: s.selectedClipId === id ? null : s.selectedClipId,
      updatedAt: Date.now()
    })),

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
    set({ highlights: out, updatedAt: Date.now() });
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
    set({ highlights: out, updatedAt: Date.now() });
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
  setUserTier: (tier) => set({ userTier: tier }),

  setLastBriefing: (b) => set({ lastBriefing: b, updatedAt: Date.now() }),

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
    set({
      sessionId: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      sources: [],
      activeSourceId: null,
      selectedSourceIds: [],
      videoBlob: null,
      videoUrl: null,
      videoMeta: s.videoMeta,
      videoHash: s.videoHash,
      plan: s.plan ?? null,
      highlights: s.highlights,
      selectedClipId: s.highlights[0]?.id ?? null,
      mode: s.mode ?? null,
      inferred: [],
      pendingClarify: null,
      userTier: "novice",
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
    const sourcesSummary: VideoSourceSummary[] = s.sources.map((x) => ({
      id: x.id,
      hash: x.hash,
      meta: x.meta,
      addedAt: x.addedAt
    }));
    await saveSession({
      id: s.sessionId,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: Date.now(),
      videoMeta: s.videoMeta,
      videoHash: s.videoHash,
      sources: sourcesSummary.length > 0 ? sourcesSummary : undefined,
      selectedSourceIds:
        s.selectedSourceIds.length > 0 ? s.selectedSourceIds : undefined,
      activeSourceId: s.activeSourceId ?? undefined,
      plan: s.plan ?? undefined,
      memory: s.memory,
      highlights: s.highlights,
      messages: s.messages,
      status: s.status,
      progress: s.progress,
      mode: s.mode ?? undefined
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

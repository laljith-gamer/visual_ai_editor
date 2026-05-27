"use client";

import { create } from "zustand";
import type {
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
  UserTier
} from "@/lib/types";
import { newId } from "@/lib/util/id";
import { GREETINGS } from "@/lib/config";
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

  // Source video (held only in memory; re-pickable from the rail)
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

  // ----- actions -----
  newSession: () => void;
  setVideo: (blob: Blob, meta: Session["videoMeta"], hash: string) => void;
  clearVideo: () => void;

  /** Replace the entire plan (fresh-plan path). */
  setPlan: (plan: EditPlan) => void;
  /** Apply a partial patch to the current plan. Returns the new plan. */
  applyPlanPatch: (patch: PlanPatch) => EditPlan | null;

  setHighlights: (h: Highlight[]) => void;
  updateHighlight: (id: string, patch: Partial<Highlight>) => void;
  removeHighlight: (id: string) => void;
  selectClip: (id: string | null) => void;

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

  // History
  refreshHistory: () => Promise<void>;
  restoreSession: (id: string) => Promise<void>;
  removeSession: (id: string) => Promise<void>;
  persist: () => Promise<void>;
}

const emptyMemory: SessionMemory = { styles: [], keep: [], skip: [] };

function freshState() {
  return {
    sessionId: newId("sess"),
    title: "Untitled session",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    videoBlob: null,
    videoUrl: null,
    videoMeta: undefined,
    videoHash: undefined,
    plan: null,
    highlights: [],
    selectedClipId: null,
    mode: null as IntentMode | null,
    inferred: [] as InferredField[],
    pendingClarify: null as EditorState["pendingClarify"],
    pendingExecution: false,
    userTier: "novice" as UserTier,
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
    statusDetail: undefined,
    memory: emptyMemory,
    renderedBlob: null,
    renderedUrl: null
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

export const useEditorStore = create<EditorState>()((set, get) => ({
  ...freshState(),
  history: [],

  newSession: () => {
    const cur = get();
    if (cur.videoUrl) URL.revokeObjectURL(cur.videoUrl);
    if (cur.renderedUrl) URL.revokeObjectURL(cur.renderedUrl);
    set({ ...freshState() });
  },

  setVideo: (blob, meta, hash) => {
    const cur = get();
    if (cur.videoUrl) URL.revokeObjectURL(cur.videoUrl);
    const url = URL.createObjectURL(blob);
    set({
      videoBlob: blob,
      videoUrl: url,
      videoMeta: meta,
      videoHash: hash,
      title: meta?.name ?? cur.title,
      updatedAt: Date.now()
    });
  },

  clearVideo: () => {
    const cur = get();
    if (cur.videoUrl) URL.revokeObjectURL(cur.videoUrl);
    if (cur.renderedUrl) URL.revokeObjectURL(cur.renderedUrl);
    set({
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

  refreshHistory: async () => {
    const sessions = await listSessions();
    set({ history: sessions });
  },

  restoreSession: async (id) => {
    const s = await loadSession(id);
    if (!s) return;
    const cur = get();
    if (cur.videoUrl) URL.revokeObjectURL(cur.videoUrl);
    if (cur.renderedUrl) URL.revokeObjectURL(cur.renderedUrl);
    set({
      sessionId: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
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
    await saveSession({
      id: s.sessionId,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: Date.now(),
      videoMeta: s.videoMeta,
      videoHash: s.videoHash,
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

"use client";

import { create } from "zustand";
import type {
  ChatMessage,
  EditPlan,
  Highlight,
  JobStatus,
  Session,
  SessionMemory
} from "@/lib/types";
import { newId } from "@/lib/util/id";
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
  setPlan: (plan: EditPlan) => void;
  setHighlights: (h: Highlight[]) => void;
  updateHighlight: (id: string, patch: Partial<Highlight>) => void;
  removeHighlight: (id: string) => void;
  selectClip: (id: string | null) => void;
  pushMessage: (m: Omit<ChatMessage, "id" | "timestamp">) => ChatMessage;
  setStatus: (s: JobStatus, detail?: string) => void;
  setProgress: (p: number) => void;
  setMemory: (patch: Partial<SessionMemory>) => void;
  setRendered: (blob: Blob | null) => void;

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
    messages: [
      {
        id: newId("m"),
        role: "assistant" as const,
        content:
          "Hey — I'm your editor. Drop a video into the rail, then tell me what kind of short you want. I'll plan the cuts, score every frame, and assemble the highlight reel.",
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
    set({
      videoBlob: null,
      videoUrl: null,
      videoMeta: undefined,
      videoHash: undefined,
      highlights: [],
      plan: null,
      renderedBlob: null,
      renderedUrl: null
    });
  },

  setPlan: (plan) =>
    set((s) => ({
      plan,
      memory: {
        ...s.memory,
        duration: plan.targetShortSeconds,
        format: plan.format,
        styles: Array.from(new Set([...s.memory.styles, ...plan.styles])).slice(0, 8),
        skip: Array.from(new Set([...s.memory.skip, ...plan.avoid])).slice(0, 8)
      },
      updatedAt: Date.now()
    })),

  setHighlights: (highlights) =>
    set({ highlights, selectedClipId: highlights[0]?.id ?? null, updatedAt: Date.now() }),

  updateHighlight: (id, patch) =>
    set((s) => ({
      highlights: s.highlights.map((h) =>
        h.id === id ? { ...h, ...patch } : h
      ),
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
      progress: s.progress
    });
    await s.refreshHistory();
  }
}));

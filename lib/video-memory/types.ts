// =====================================================================
// lib/video-memory/types.ts
//
// Persistent, privacy-first video memory types.
//
// This is the bridge between the deterministic frame tree and the offline
// planner: it stores a searchable hierarchy keyed by video hash. It stores
// metadata, summaries, tags, scores, links, and user feedback — never video
// bytes and never base64 frames.
// =====================================================================

export const VIDEO_MEMORY_VERSION = 1;

export type VideoMemoryNodeKind = "root" | "chapter" | "scene" | "shot" | "leaf";

export type VideoMemoryLinkType =
  | "same_topic"
  | "same_object"
  | "same_person"
  | "repeated_concept"
  | "cause_effect"
  | "earlier_to_later"
  | "user_related";

export interface VideoMemoryScores {
  meanMotion?: number;
  meanSaliency?: number;
  peakMotion?: number;
}

export interface VideoMemoryFeedback {
  acceptedClipCount: number;
  rejectedClipCount: number;
  lastAcceptedAt?: number;
  lastRejectedAt?: number;
  notes: string[];
}

export interface VideoMemoryNode {
  id: string;
  kind: VideoMemoryNodeKind;
  parentId?: string;
  childIds: string[];
  start: number;
  end: number;
  duration: number;
  summary: string;
  tags: string[];
  confidence: number;
  scores: VideoMemoryScores;
  keyframeT?: number;
  sourceRef?: {
    frameTreeId?: string;
    frameRange?: [number, number];
  };
  embedding?: number[];
  timelineLogs: string[];
  feedback: VideoMemoryFeedback;
  createdAt: number;
  updatedAt: number;
}

export interface VideoMemoryGraphLink {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  type: VideoMemoryLinkType;
  weight: number;
  reason?: string;
}

export interface VideoMemoryIndex {
  version: typeof VIDEO_MEMORY_VERSION;
  videoHash: string;
  sourceId?: string;
  videoName?: string;
  duration: number;
  rootId: string;
  nodes: Record<string, VideoMemoryNode>;
  links: VideoMemoryGraphLink[];
  stats: {
    rootCount: number;
    chapterCount: number;
    sceneCount: number;
    shotCount: number;
    leafCount: number;
    linkCount: number;
  };
  createdAt: number;
  updatedAt: number;
}

export interface BuildVideoMemoryInput {
  videoHash: string;
  duration: number;
  sourceId?: string;
  videoName?: string;
  now?: number;
}

export interface VideoMemoryQueryOptions {
  limit?: number;
  includeKinds?: VideoMemoryNodeKind[];
  minConfidence?: number;
}

export interface RankedVideoMemoryNode {
  node: VideoMemoryNode;
  score: number;
  reasons: string[];
}

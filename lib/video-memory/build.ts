// =====================================================================
// lib/video-memory/build.ts
//
// Build a persistent video-memory tree from the deterministic frame tree.
// No model calls, no I/O, no pixels. This creates the hierarchy the offline
// planner can later retrieve from: root → chapters → scenes → shots.
// =====================================================================

import type { ChapterNode, FrameTree, SceneNode, ShotNode } from "@/lib/frame-tree";
import {
  VIDEO_MEMORY_VERSION,
  type BuildVideoMemoryInput,
  type VideoMemoryIndex,
  type VideoMemoryNode
} from "@/lib/video-memory/types";

export function buildVideoMemoryFromFrameTree(
  tree: FrameTree,
  input: BuildVideoMemoryInput
): VideoMemoryIndex {
  const now = input.now ?? Date.now();
  const nodes: Record<string, VideoMemoryNode> = {};
  const rootId = "root";

  const add = (node: VideoMemoryNode): void => {
    nodes[node.id] = node;
  };

  const chapterIds = tree.chapters.map((chapter, chapterIndex) => {
    const chapterId = memoryId("chapter", chapterIndex);
    const sceneIds = chapter.scenes.map((scene) => sceneMemoryId(scene));
    add(makeChapterNode(chapter, chapterId, rootId, sceneIds, now));

    for (const scene of chapter.scenes) {
      const sceneId = sceneMemoryId(scene);
      const shotIds = scene.shots.map((shot) => shotMemoryId(shot));
      add(makeSceneNode(scene, sceneId, chapterId, shotIds, now));

      for (const shot of scene.shots) {
        add(makeShotNode(shot, shotMemoryId(shot), sceneId, now));
      }
    }

    return chapterId;
  });

  add(makeRootNode(tree, input, rootId, chapterIds, now));

  const stats = Object.values(nodes).reduce(
    (acc, node) => {
      if (node.kind === "root") acc.rootCount += 1;
      if (node.kind === "chapter") acc.chapterCount += 1;
      if (node.kind === "scene") acc.sceneCount += 1;
      if (node.kind === "shot") acc.shotCount += 1;
      if (node.kind === "leaf") acc.leafCount += 1;
      return acc;
    },
    {
      rootCount: 0,
      chapterCount: 0,
      sceneCount: 0,
      shotCount: 0,
      leafCount: 0,
      linkCount: 0
    }
  );

  return {
    version: VIDEO_MEMORY_VERSION,
    videoHash: input.videoHash,
    sourceId: input.sourceId,
    videoName: input.videoName,
    duration: round2(input.duration || tree.duration),
    rootId,
    nodes,
    links: [],
    stats,
    createdAt: now,
    updatedAt: now
  };
}

function makeRootNode(
  tree: FrameTree,
  input: BuildVideoMemoryInput,
  id: string,
  childIds: string[],
  now: number
): VideoMemoryNode {
  return baseNode({
    id,
    kind: "root",
    childIds,
    start: 0,
    end: round2(input.duration || tree.duration),
    summary: rootSummary(tree, input.videoName),
    tags: unique(tree.chapters.flatMap((chapter) => chapter.label.split(/\s+/g))),
    confidence: tree.frameCount > 0 ? 0.65 : 0.2,
    scores: {
      meanMotion: mean(tree.chapters.map((chapter) => chapter.meanMotion)),
      meanSaliency: mean(tree.chapters.map((chapter) => chapter.meanSaliency)),
      peakMotion: max(tree.chapters.map((chapter) => chapter.peakMotion))
    },
    now
  });
}

function makeChapterNode(
  chapter: ChapterNode,
  id: string,
  parentId: string,
  childIds: string[],
  now: number
): VideoMemoryNode {
  return baseNode({
    id,
    kind: "chapter",
    parentId,
    childIds,
    start: chapter.start,
    end: chapter.end,
    summary: `${chapter.label || "chapter"} from ${formatTime(chapter.start)} to ${formatTime(chapter.end)}`,
    tags: tokenizeTags(chapter.label),
    confidence: confidenceFromFrames(chapter.frameCount),
    scores: {
      meanMotion: chapter.meanMotion,
      meanSaliency: chapter.meanSaliency,
      peakMotion: chapter.peakMotion
    },
    sourceRef: { frameTreeId: chapter.id },
    now
  });
}

function makeSceneNode(
  scene: SceneNode,
  id: string,
  parentId: string,
  childIds: string[],
  now: number
): VideoMemoryNode {
  const tags = unique(scene.tags);
  return baseNode({
    id,
    kind: "scene",
    parentId,
    childIds,
    start: scene.start,
    end: scene.end,
    summary: `${tags.join(" ") || "scene"} scene from ${formatTime(scene.start)} to ${formatTime(scene.end)}`,
    tags,
    confidence: confidenceFromFrames(scene.frameCount),
    scores: {
      meanMotion: scene.meanMotion,
      meanSaliency: scene.meanSaliency,
      peakMotion: scene.peakMotion
    },
    sourceRef: { frameTreeId: scene.id },
    now
  });
}

function makeShotNode(
  shot: ShotNode,
  id: string,
  parentId: string,
  now: number
): VideoMemoryNode {
  const tags = [energyTag(shot.meanMotion), saliencyTag(shot.meanSaliency)];
  return baseNode({
    id,
    kind: "shot",
    parentId,
    childIds: [],
    start: shot.start,
    end: shot.end,
    summary: `${tags.join(" ")} shot from ${formatTime(shot.start)} to ${formatTime(shot.end)}`,
    tags,
    confidence: confidenceFromFrames(shot.frameCount),
    scores: {
      meanMotion: shot.meanMotion,
      meanSaliency: shot.meanSaliency,
      peakMotion: shot.peakMotion
    },
    keyframeT: shot.keyframeT,
    sourceRef: { frameTreeId: shot.id, frameRange: shot.frameRange },
    now
  });
}

function baseNode(input: {
  id: string;
  kind: VideoMemoryNode["kind"];
  parentId?: string;
  childIds: string[];
  start: number;
  end: number;
  summary: string;
  tags: string[];
  confidence: number;
  scores: VideoMemoryNode["scores"];
  keyframeT?: number;
  sourceRef?: VideoMemoryNode["sourceRef"];
  now: number;
}): VideoMemoryNode {
  return {
    id: input.id,
    kind: input.kind,
    parentId: input.parentId,
    childIds: input.childIds,
    start: round2(input.start),
    end: round2(input.end),
    duration: round2(Math.max(0, input.end - input.start)),
    summary: input.summary,
    tags: unique(input.tags),
    confidence: clamp01(input.confidence),
    scores: input.scores,
    keyframeT: input.keyframeT,
    sourceRef: input.sourceRef,
    timelineLogs: [],
    feedback: {
      acceptedClipCount: 0,
      rejectedClipCount: 0,
      notes: []
    },
    createdAt: input.now,
    updatedAt: input.now
  };
}

function rootSummary(tree: FrameTree, videoName?: string): string {
  const label = videoName ? `"${videoName}"` : "video";
  return `${label}: ${tree.stats.chapterCount} chapters, ${tree.stats.sceneCount} scenes, ${tree.stats.shotCount} shots, ${tree.frameCount} sampled frames`;
}

function sceneMemoryId(scene: SceneNode): string {
  return scene.id.replace(/^scene_/, "memory_scene_");
}

function shotMemoryId(shot: ShotNode): string {
  return shot.id.replace(/^shot_/, "memory_shot_");
}

function memoryId(prefix: string, index: number): string {
  return `memory_${prefix}_${String(index + 1).padStart(4, "0")}`;
}

function confidenceFromFrames(frameCount: number): number {
  if (frameCount <= 0) return 0.1;
  if (frameCount >= 8) return 0.75;
  return round2(0.35 + frameCount * 0.05);
}

function energyTag(meanMotion: number): string {
  return meanMotion >= 0.6
    ? "high-motion"
    : meanMotion >= 0.3
      ? "moderate-motion"
      : "low-motion";
}

function saliencyTag(meanSaliency: number): string {
  return meanSaliency >= 0.65
    ? "high-saliency"
    : meanSaliency >= 0.35
      ? "moderate-saliency"
      : "low-saliency";
}

function tokenizeTags(text: string): string[] {
  return unique(
    text
      .toLowerCase()
      .split(/[^a-z0-9-]+/g)
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function mean(values: Array<number | undefined>): number | undefined {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return nums.length > 0 ? round2(nums.reduce((a, b) => a + b, 0) / nums.length) : undefined;
}

function max(values: Array<number | undefined>): number | undefined {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return nums.length > 0 ? round2(Math.max(...nums)) : undefined;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, round2(n)));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

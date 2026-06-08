// =====================================================================
// lib/frame-tree/build.ts
//
// Build the FRAME-ORGANIZATION TREE from a flat list of sampled frames.
//
//     frames → shots → scenes → chapters
//
// Algorithm (single forward pass + two cheap grouping passes):
//
//   1. SHOTS:    walk frames; start a new shot whenever motion spikes
//                above `shotBreakMotion` (a hard cut). Each shot is a
//                run of visually-continuous frames.
//   2. SCENES:   merge adjacent shots whose mean energy is similar
//                (and, when captions exist, whose topic overlaps). A
//                jump in energy or topic starts a new scene.
//   3. CHAPTERS: chunk scenes into a handful of coarse top-level parts,
//                capped by `scenesPerChapter`, so long videos get a
//                navigable outline rather than 40 flat scenes.
//
// Guarantees: deterministic (no rng/clock), grounded (all times come
// from real frame timestamps, clamped to [0, duration]), pure (no I/O).
// Complexity: O(n) frames + O(shots) + O(scenes).
// =====================================================================

import type {
  BuildTreeOptions,
  ChapterNode,
  FrameInput,
  FrameTree,
  SceneNode,
  ShotNode,
  TreeFrame
} from "@/lib/frame-tree/types";

const DEFAULTS = {
  /** Motion delta forcing a shot boundary. Matches the engine's
   *  scene-break sensitivity so the two layers agree. */
  shotBreakMotion: 0.45,
  /** Scenes grouped under one chapter before starting a new one. */
  scenesPerChapter: 5,
  /** Mean-energy gap that splits two shots into separate scenes. */
  sceneEnergyDelta: 0.2,
  /** Caption token Jaccard below this also splits a scene (when both
   *  shots carry captions). */
  captionContinuityFloor: 0.18
} as const;

// ---------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------

/**
 * Build a FrameTree from sampled frames. Returns an empty-but-valid tree
 * when there are no frames, so callers never need null checks.
 */
export function buildFrameTree(
  frames: FrameInput[],
  options: BuildTreeOptions
): FrameTree {
  const duration =
    Number.isFinite(options.duration) && options.duration > 0
      ? options.duration
      : 0;

  const norm = normalizeFrames(frames, duration);
  if (norm.length === 0) {
    return emptyTree(duration);
  }

  const samplePeriod = estimateSamplePeriod(norm);
  const shotBreak = clampUnit(options.shotBreakMotion) ?? DEFAULTS.shotBreakMotion;
  const scenesPerChapter = Math.max(
    1,
    Math.round(options.scenesPerChapter ?? DEFAULTS.scenesPerChapter)
  );
  const sceneDelta =
    clampUnit(options.sceneEnergyDelta) ?? DEFAULTS.sceneEnergyDelta;

  const shots = buildShots(norm, duration, samplePeriod, shotBreak);
  const scenes = buildScenes(shots, sceneDelta);
  const chapters = buildChapters(scenes, scenesPerChapter);

  return {
    duration: round2(duration),
    frameCount: norm.length,
    samplePeriod: round2(samplePeriod),
    chapters,
    scenes,
    shots,
    stats: {
      chapterCount: chapters.length,
      sceneCount: scenes.length,
      shotCount: shots.length
    }
  };
}

// ---------------------------------------------------------------------
// 1) SHOTS
// ---------------------------------------------------------------------

function buildShots(
  frames: TreeFrame[],
  duration: number,
  samplePeriod: number,
  shotBreakMotion: number
): ShotNode[] {
  const shots: ShotNode[] = [];
  let startIdx = 0;

  const flush = (endIdx: number): void => {
    const slice = frames.slice(startIdx, endIdx + 1);
    const start = slice[0].t;
    // End is bounded by the next frame after the shot (or duration), so
    // adjacent shots tile the timeline without gaps or overlaps.
    const next = frames[endIdx + 1];
    const end = clamp(
      next ? next.t : slice[slice.length - 1].t + samplePeriod,
      start,
      duration
    );
    shots.push(makeShot(shots.length, slice, [startIdx, endIdx], start, end));
  };

  for (let i = 1; i < frames.length; i++) {
    // A motion spike on the CURRENT frame marks a hard cut: the previous
    // frame ends the old shot, this frame starts the new one.
    if (frames[i].motion >= shotBreakMotion) {
      flush(i - 1);
      startIdx = i;
    }
  }
  flush(frames.length - 1);
  return shots;
}

function makeShot(
  index: number,
  slice: TreeFrame[],
  frameRange: [number, number],
  start: number,
  end: number
): ShotNode & CaptionCarrier {
  const motions = slice.map((f) => f.motion);
  const sals = slice.map((f) => f.saliency);
  const peakMotion = Math.max(...motions);
  // Keyframe = the peak-motion frame (most representative "action" frame).
  let keyframeT = slice[0].t;
  let peak = -1;
  for (const f of slice) {
    if (f.motion > peak) {
      peak = f.motion;
      keyframeT = f.t;
    }
  }
  return {
    kind: "shot",
    id: nodeId("shot", index),
    start: round2(start),
    end: round2(end),
    duration: round2(Math.max(0, end - start)),
    meanMotion: round2(mean(motions)),
    meanSaliency: round2(mean(sals)),
    peakMotion: round2(peakMotion),
    frameCount: slice.length,
    frameRange,
    keyframeT: round2(keyframeT),
    // Carry captions through privately for scene grouping; not part of
    // the public ShotNode surface but attached non-enumerably below.
    ...attachCaptionTokens(slice)
  };
}

// We stash caption tokens on the shot for the scene-grouping pass without
// widening the public type. They're plain data, still deterministic.
interface CaptionCarrier {
  _captionTokens?: string[];
}
function attachCaptionTokens(slice: TreeFrame[]): CaptionCarrier {
  const toks = new Set<string>();
  for (const f of slice) {
    if (f.caption) for (const t of tokenize(f.caption)) toks.add(t);
  }
  return toks.size > 0 ? { _captionTokens: [...toks] } : {};
}

// ---------------------------------------------------------------------
// 2) SCENES
// ---------------------------------------------------------------------

function buildScenes(shots: ShotNode[], sceneEnergyDelta: number): SceneNode[] {
  if (shots.length === 0) return [];
  const scenes: SceneNode[] = [];
  let group: ShotNode[] = [shots[0]];

  for (let i = 1; i < shots.length; i++) {
    const prev = shots[i - 1];
    const curr = shots[i];

    const energyJump =
      Math.abs(curr.meanMotion - prev.meanMotion) > sceneEnergyDelta;

    let topicChange = false;
    const pt = (prev as ShotNode & CaptionCarrier)._captionTokens;
    const ct = (curr as ShotNode & CaptionCarrier)._captionTokens;
    if (pt && ct && pt.length > 0 && ct.length > 0) {
      topicChange = jaccard(pt, ct) < DEFAULTS.captionContinuityFloor;
    }

    if (energyJump || topicChange) {
      scenes.push(makeScene(scenes.length, group));
      group = [curr];
    } else {
      group.push(curr);
    }
  }
  scenes.push(makeScene(scenes.length, group));
  return scenes;
}

function makeScene(index: number, shots: ShotNode[]): SceneNode {
  const start = shots[0].start;
  const end = shots[shots.length - 1].end;
  const frameCount = shots.reduce((a, s) => a + s.frameCount, 0);
  // Frame-count-weighted means so long shots dominate appropriately.
  const meanMotion = weightedMean(
    shots.map((s) => s.meanMotion),
    shots.map((s) => s.frameCount)
  );
  const meanSaliency = weightedMean(
    shots.map((s) => s.meanSaliency),
    shots.map((s) => s.frameCount)
  );
  const peakMotion = Math.max(...shots.map((s) => s.peakMotion));

  const tags = deriveSceneTags(shots, meanMotion);

  const scene: SceneNode = {
    kind: "scene",
    id: nodeId("scene", index),
    start: round2(start),
    end: round2(end),
    duration: round2(Math.max(0, end - start)),
    meanMotion: round2(meanMotion),
    meanSaliency: round2(meanSaliency),
    peakMotion: round2(peakMotion),
    frameCount,
    shots,
    tags
  };
  return scene;
}

function deriveSceneTags(shots: ShotNode[], meanMotion: number): string[] {
  // Prefer caption-derived tags when available.
  const counts = new Map<string, number>();
  for (const s of shots) {
    const toks = (s as ShotNode & CaptionCarrier)._captionTokens;
    if (toks) for (const t of toks) {
      if (STOP_WORDS.has(t) || t.length < 3) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  if (counts.size > 0) {
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, 4)
      .map(([t]) => t);
  }
  // No captions: a single literal energy descriptor.
  const energy =
    meanMotion >= 0.6 ? "high-motion" : meanMotion >= 0.3 ? "moderate-motion" : "static";
  return [energy];
}

// ---------------------------------------------------------------------
// 3) CHAPTERS
// ---------------------------------------------------------------------

function buildChapters(
  scenes: SceneNode[],
  scenesPerChapter: number
): ChapterNode[] {
  if (scenes.length === 0) return [];
  const chapters: ChapterNode[] = [];
  for (let i = 0; i < scenes.length; i += scenesPerChapter) {
    const group = scenes.slice(i, i + scenesPerChapter);
    chapters.push(makeChapter(chapters.length, group));
  }
  return chapters;
}

function makeChapter(index: number, scenes: SceneNode[]): ChapterNode {
  const start = scenes[0].start;
  const end = scenes[scenes.length - 1].end;
  const frameCount = scenes.reduce((a, s) => a + s.frameCount, 0);
  const meanMotion = weightedMean(
    scenes.map((s) => s.meanMotion),
    scenes.map((s) => s.frameCount)
  );
  const meanSaliency = weightedMean(
    scenes.map((s) => s.meanSaliency),
    scenes.map((s) => s.frameCount)
  );
  const peakMotion = Math.max(...scenes.map((s) => s.peakMotion));

  // Chapter label = the most common scene tags across the chapter.
  const counts = new Map<string, number>();
  for (const s of scenes) for (const t of s.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  const topTags = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 3)
    .map(([t]) => t);
  const label = topTags.length > 0 ? topTags.join(" ") : `part ${index + 1}`;

  return {
    kind: "chapter",
    id: nodeId("chapter", index),
    start: round2(start),
    end: round2(end),
    duration: round2(Math.max(0, end - start)),
    meanMotion: round2(meanMotion),
    meanSaliency: round2(meanSaliency),
    peakMotion: round2(peakMotion),
    frameCount,
    scenes,
    label
  };
}

// ---------------------------------------------------------------------
// Frame normalization
// ---------------------------------------------------------------------

function normalizeFrames(frames: FrameInput[], duration: number): TreeFrame[] {
  if (!Array.isArray(frames)) return [];
  const cap = duration > 0 ? duration + 0.001 : Infinity;
  return frames
    .filter(
      (f) =>
        f &&
        typeof f.t === "number" &&
        Number.isFinite(f.t) &&
        f.t >= 0 &&
        f.t <= cap
    )
    .map((f) => ({
      t: duration > 0 ? clamp(f.t, 0, duration) : f.t,
      motion: clampUnit(f.motion) ?? 0,
      saliency: clampUnit(f.saliency) ?? 0,
      caption: typeof f.caption === "string" && f.caption.trim() ? f.caption : undefined
    }))
    .sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------------
// Lexicon + helpers
// ---------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "is", "are",
  "was", "were", "with", "for", "as", "by", "this", "that", "these", "those",
  "it", "its", "be", "from", "into", "over", "shows", "showing", "image",
  "frame", "scene", "video", "picture", "photo"
]);

function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function estimateSamplePeriod(frames: TreeFrame[]): number {
  if (frames.length < 2) return 1;
  const deltas: number[] = [];
  for (let i = 1; i < frames.length; i++) deltas.push(frames[i].t - frames[i - 1].t);
  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  const m =
    deltas.length % 2 === 0 ? (deltas[mid - 1] + deltas[mid]) / 2 : deltas[mid];
  return m > 0 ? m : 1;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function weightedMean(values: number[], weights: number[]): number {
  let num = 0;
  let den = 0;
  for (let i = 0; i < values.length; i++) {
    const w = weights[i] ?? 0;
    num += values[i] * w;
    den += w;
  }
  return den > 0 ? num / den : mean(values);
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function clampUnit(n: unknown): number | undefined {
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function nodeId(kind: string, index: number): string {
  return `${kind}_${String(index + 1).padStart(4, "0")}`;
}

function emptyTree(duration: number): FrameTree {
  return {
    duration: round2(duration),
    frameCount: 0,
    samplePeriod: 1,
    chapters: [],
    scenes: [],
    shots: [],
    stats: { chapterCount: 0, sceneCount: 0, shotCount: 0 }
  };
}

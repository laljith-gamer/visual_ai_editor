// =====================================================================
// lib/frame-tree/types.ts
//
// Types for the in-browser FRAME-ORGANIZATION TREE.
//
// Right after a video is uploaded and sampled, we organize the flat list
// of sampled frames into a hierarchy:
//
//     chapters → scenes → shots → frames
//
// This structure is:
//   - DETERMINISTIC: same frames in → same tree out (no clock, no rng).
//   - FAST: pure JS over the motion/saliency signals the sampler already
//     produced. No model, no I/O. O(n) in the number of frames.
//   - GROUNDED: every node's time bounds come from real frame timestamps.
//
// The tree feeds two consumers:
//   1. VISION-EDIT-CORE (the offline reasoning engine) as its `tree`
//      input — a coarse temporal summary it can reason over without
//      re-walking every frame.
//   2. The UI, as a navigable outline of the footage.
//
// PURE TYPES only — no runtime, no imports.
// =====================================================================

/** A single leaf frame in the tree. Mirrors the fields the sampler
 *  produces (lib/pipeline/sample.ts → SampledFrame), minus the blob —
 *  the tree is metadata only and never holds pixel data. */
export interface TreeFrame {
  /** Timestamp in seconds. */
  t: number;
  /** Motion signal 0..1 (frame-diff vs previous sample). */
  motion: number;
  /** Saliency signal 0..1 (brightness-histogram entropy). */
  saliency: number;
  /** Optional caption, populated only when a captioning stage ran. */
  caption?: string;
}

/** Common aggregate fields shared by every non-leaf node. */
export interface TreeNodeBase {
  /** Stable, deterministic id ("shot_0001", "scene_0002", …). */
  id: string;
  /** Start time in seconds (first frame of the node). */
  start: number;
  /** End time in seconds (bounded by the next sample or duration). */
  end: number;
  /** end - start. */
  duration: number;
  /** Mean motion across the node's frames, 0..1. */
  meanMotion: number;
  /** Mean saliency across the node's frames, 0..1. */
  meanSaliency: number;
  /** Peak motion within the node, 0..1 (useful as an "action" cue). */
  peakMotion: number;
  /** Number of leaf frames under this node. */
  frameCount: number;
}

/** A SHOT: the finest grouping — a run of visually-continuous frames
 *  bounded by a motion spike (a cut / hard transition). */
export interface ShotNode extends TreeNodeBase {
  kind: "shot";
  /** Index range into the flat frame array [startIdx, endIdx] inclusive. */
  frameRange: [number, number];
  /** Representative frame timestamp (peak-motion frame in the shot). */
  keyframeT: number;
}

/** A SCENE: a group of adjacent shots that belong together (similar
 *  visual energy and, when captions exist, similar topic). */
export interface SceneNode extends TreeNodeBase {
  kind: "scene";
  shots: ShotNode[];
  /** Distilled tags (from captions when present, else energy descriptor). */
  tags: string[];
}

/** A CHAPTER: a coarse top-level segment of the video, grouping scenes
 *  into a handful of high-level parts (intro / body / outro-like spans). */
export interface ChapterNode extends TreeNodeBase {
  kind: "chapter";
  scenes: SceneNode[];
  /** Short literal label derived from the chapter's scenes. */
  label: string;
}

/** The full tree for one video source. */
export interface FrameTree {
  /** Video duration in seconds (bounds all clamps). */
  duration: number;
  /** Total leaf frames the tree was built from. */
  frameCount: number;
  /** Estimated sampling period (median frame delta), seconds. */
  samplePeriod: number;
  /** Top-level chapters, ascending by start. */
  chapters: ChapterNode[];
  /** Flattened scenes for quick consumers (ascending by start). */
  scenes: SceneNode[];
  /** Flattened shots for quick consumers (ascending by start). */
  shots: ShotNode[];
  /** Coarse counts for logging / UI. */
  stats: {
    chapterCount: number;
    sceneCount: number;
    shotCount: number;
  };
}

/** Tunables for tree construction. All optional; documented defaults
 *  live in the builder. */
export interface BuildTreeOptions {
  /** Video duration in seconds. Required for grounded end-clamping. */
  duration: number;
  /** Motion delta (0..1) between adjacent frames that forces a SHOT
   *  boundary (a hard cut). Higher → fewer, longer shots. */
  shotBreakMotion?: number;
  /** Max scenes per chapter before a new chapter is started. */
  scenesPerChapter?: number;
  /** Difference in mean energy that separates two shots into different
   *  scenes (0..1). Higher → fewer, broader scenes. */
  sceneEnergyDelta?: number;
}

/** The lightweight frame input the builder accepts. Accepts the real
 *  SampledFrame (which has extra fields like `blob`) structurally. */
export interface FrameInput {
  t: number;
  motion: number;
  saliency: number;
  caption?: string;
}

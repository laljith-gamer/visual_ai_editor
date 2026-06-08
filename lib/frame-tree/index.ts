// =====================================================================
// lib/frame-tree/index.ts
//
// Public surface for the in-browser FRAME-ORGANIZATION TREE.
//
// Typical usage (right after sampling, before/alongside scoring):
//
//   import { buildFrameTree, frameTreeToVisionCoreTree } from "@/lib/frame-tree";
//
//   const frames = await sampleFrames(blob, { every: 1, width: 256 });
//   const tree = buildFrameTree(frames, { duration });
//   // → feed `frameTreeToVisionCoreTree(tree)` to VISION-EDIT-CORE as `tree`,
//   //   and/or render `tree.chapters` as a navigable outline in the UI.
//
// Pure, deterministic, side-effect-free, tree-shakeable.
// =====================================================================

export { buildFrameTree } from "@/lib/frame-tree/build";
export {
  frameTreeToVisionCoreTree,
  frameTreeToOutline,
  type VisionCoreTreeView
} from "@/lib/frame-tree/adapt";
export type {
  FrameTree,
  FrameInput,
  TreeFrame,
  TreeNodeBase,
  ShotNode,
  SceneNode,
  ChapterNode,
  BuildTreeOptions
} from "@/lib/frame-tree/types";

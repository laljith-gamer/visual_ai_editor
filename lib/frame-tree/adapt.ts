// =====================================================================
// lib/frame-tree/adapt.ts
//
// Convert the rich FrameTree into the loose `{ levels, root }` shape that
// the VISION-EDIT-CORE engine accepts as its optional `tree` input.
//
// The engine treats `tree` as an opaque temporal summary (its type is
// intentionally loose: `{ levels?: Record<string, unknown>; root?: ... }`).
// We emit a compact, JSON-serializable view here so the engine — or a
// local LLM prompt — can reason over the structure without re-walking
// every frame, and without holding any pixel data.
//
// PURE + DETERMINISTIC. No imports from the engine (keeps this module
// independently shippable before the engine lands on main).
// =====================================================================

import type { FrameTree } from "@/lib/frame-tree/types";

/** The loose tree shape the engine consumes. Mirrors VisionCoreTree. */
export interface VisionCoreTreeView {
  levels: {
    chapters: Array<{
      id: string;
      start: number;
      end: number;
      label: string;
      meanMotion: number;
      sceneIds: string[];
    }>;
    scenes: Array<{
      id: string;
      start: number;
      end: number;
      tags: string[];
      meanMotion: number;
      meanSaliency: number;
      peakMotion: number;
      shotIds: string[];
    }>;
    shots: Array<{
      id: string;
      start: number;
      end: number;
      keyframeT: number;
      meanMotion: number;
      peakMotion: number;
    }>;
  };
  root: {
    duration: number;
    frameCount: number;
    samplePeriod: number;
    chapterCount: number;
    sceneCount: number;
    shotCount: number;
  };
}

/**
 * Project a FrameTree into the engine's `tree` view. Drops per-frame
 * detail (keeps only aggregates + child id references) so the payload
 * stays small even for long videos.
 */
export function frameTreeToVisionCoreTree(tree: FrameTree): VisionCoreTreeView {
  return {
    levels: {
      chapters: tree.chapters.map((c) => ({
        id: c.id,
        start: c.start,
        end: c.end,
        label: c.label,
        meanMotion: c.meanMotion,
        sceneIds: c.scenes.map((s) => s.id)
      })),
      scenes: tree.scenes.map((s) => ({
        id: s.id,
        start: s.start,
        end: s.end,
        tags: s.tags,
        meanMotion: s.meanMotion,
        meanSaliency: s.meanSaliency,
        peakMotion: s.peakMotion,
        shotIds: s.shots.map((sh) => sh.id)
      })),
      shots: tree.shots.map((sh) => ({
        id: sh.id,
        start: sh.start,
        end: sh.end,
        keyframeT: sh.keyframeT,
        meanMotion: sh.meanMotion,
        peakMotion: sh.peakMotion
      }))
    },
    root: {
      duration: tree.duration,
      frameCount: tree.frameCount,
      samplePeriod: tree.samplePeriod,
      chapterCount: tree.stats.chapterCount,
      sceneCount: tree.stats.sceneCount,
      shotCount: tree.stats.shotCount
    }
  };
}

/**
 * Render a tiny, token-lean text outline of the tree — useful as grounding
 * context for a local LLM prompt (one line per chapter, indented scenes).
 * Deterministic and bounded in size.
 */
export function frameTreeToOutline(tree: FrameTree, maxLines = 60): string {
  const lines: string[] = [];
  lines.push(
    `VIDEO ${fmt(tree.duration)} — ${tree.stats.chapterCount} chapters, ${tree.stats.sceneCount} scenes, ${tree.stats.shotCount} shots`
  );
  for (const c of tree.chapters) {
    if (lines.length >= maxLines) break;
    lines.push(`# ${c.id} ${fmt(c.start)}-${fmt(c.end)} "${c.label}"`);
    for (const s of c.scenes) {
      if (lines.length >= maxLines) break;
      const energy =
        s.meanMotion >= 0.6 ? "high" : s.meanMotion >= 0.3 ? "med" : "low";
      lines.push(
        `  - ${s.id} ${fmt(s.start)}-${fmt(s.end)} [${energy}] ${s.tags.join(", ")}`
      );
    }
  }
  return lines.join("\n");
}

function fmt(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

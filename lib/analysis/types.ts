// =====================================================================
// lib/analysis/types.ts
//
// Shared types for the dynamic, progressive, LOCAL-ONLY video-analysis
// system. Pure type declarations — no runtime imports, no browser APIs,
// so every consumer (and its tests) can import them freely.
//
// Privacy: nothing here is a place to store raw video bytes or full frame
// images. `VideoAnalysisMemory` holds compact derived metadata ONLY
// (time ranges, scores, a tiny per-keyframe summary). See videoMemory.ts.
// =====================================================================

/** Why we're analysing — drives the frame budget. A human editor scans a
 *  different amount for each of these. */
export type AnalysisPurpose =
  | "none"
  | "metadata"
  | "quick_describe"
  | "quick_best_parts"
  | "normal_highlights"
  | "specific_visual_search"
  | "deep_story"
  | "transcript_search";

/** Coarse local capability estimate (NOT a fingerprint). */
export type DeviceTier = "low" | "mid" | "high" | "unknown";

/** How specific the user's request is — also drives budget + clarification. */
export type PromptSpecificity = "exact" | "simple" | "normal" | "specific" | "vague";

// ---------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------

export interface AnalysisBudgetInput {
  durationSeconds: number;
  width?: number;
  height?: number;
  sourceCount: number;
  purpose: AnalysisPurpose;
  deviceTier: DeviceTier;
  hasCachedQuickScan: boolean;
  hasCachedDeepScan: boolean;
  userSpecifiedDuration?: boolean;
  targetSeconds?: number;
  promptSpecificity: PromptSpecificity;
}

export interface AnalysisBudget {
  purpose: AnalysisPurpose;
  /** Upper bound on frames to score in the FIRST (coarse) pass. 0 = no AI. */
  maxFrames: number;
  /** Seconds between sampled frames for the coarse pass. */
  sampleEverySeconds: number;
  /** Target width (px) for inference frames. */
  inferenceWidth: number;
  /** Whether a semantic (SigLIP/local-vision) pass is allowed at all. */
  allowSemanticPass: boolean;
  /** Whether a dense second pass around top windows is allowed. */
  allowDenseWindowPass: boolean;
  /** Frames sampled inside each dense candidate window. */
  denseFramesPerWindow: number;
  /** Max candidate windows that get the dense pass. */
  maxCandidateWindows: number;
  /** Human-readable explanation (also good for the activity log + chat). */
  reason: string;
}

// ---------------------------------------------------------------------
// Progressive analysis memory (compact — NO raw frames / blobs)
// ---------------------------------------------------------------------

/** 0 metadata · 1 quick scan · 2 scene map · 3 local semantic · 4 transcript-aware. */
export type VideoAnalysisLevel = 0 | 1 | 2 | 3 | 4;

/** A scored time range. Generic — used for motion/saliency/static/window peaks. */
export interface TimeRangeScore {
  start: number;
  end: number;
  score: number;
  /** Optional short label / reason ("high motion", "static"). */
  label?: string;
}

export interface SceneRange {
  start: number;
  end: number;
  /** Change strength at the scene boundary (0..1), if known. */
  changeStrength?: number;
}

/** Compact per-keyframe memory. NEVER stores the image — only a tiny
 *  derived summary + scores. */
export interface KeyframeMemory {
  t: number;
  motion?: number;
  saliency?: number;
  /** Optional one-line caption IF local captioning produced one. */
  caption?: string;
}

export interface VideoAnalysisMemory {
  videoHash: string;
  sourceId: string;
  sourceName: string;
  durationSeconds: number;
  width?: number;
  height?: number;
  updatedAt: number;
  level: VideoAnalysisLevel;
  /** 0..1 confidence in the current analysis for THIS video. */
  confidence: number;
  summary?: string;
  sceneMap: SceneRange[];
  keyframes: KeyframeMemory[];
  motionPeaks: TimeRangeScore[];
  saliencyPeaks: TimeRangeScore[];
  staticRanges: TimeRangeScore[];
  knownGoodWindows: TimeRangeScore[];
  weakWindows: TimeRangeScore[];
  rejectedWindows: TimeRangeScore[];
  /** Likely role in a multi-video edit ("intro", "main action", …). */
  sourceRole?: string;
  topics?: string[];
  warnings?: string[];
}

/** A partial patch merged into an existing memory (videoMemory.mergeVideoMemory). */
export type VideoAnalysisMemoryPatch = Partial<
  Omit<VideoAnalysisMemory, "videoHash" | "sourceId">
> & {
  videoHash?: string;
  sourceId?: string;
};

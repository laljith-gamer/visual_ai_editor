/**
 * v1.6.0 — Per-source pipeline execution.
 *
 * Runs the full sample → score → temporal → buildHighlights flow
 * for ONE video source and returns the resulting highlights tagged
 * with the source's id. The orchestrator owns UI/store mutations.
 */

import type {
  CapabilityTier,
  EditPlan,
  FrameScore,
  Highlight,
  ScoreStats,
  UserTier,
  VideoSource
} from "@/lib/types";
import type { Transcript } from "@/lib/audio/types";
import { sampleFrames } from "./sample";
import { scoreFrames } from "./score";
import { detectCandidateWindows } from "./events";
import { runTemporalPass } from "./temporal";
import { buildHighlights } from "./highlights";
import { buildMomentHighlight } from "./moment";
import { applyConstraintFilter } from "@/lib/constraints/filter";
import { isConstraintDriven } from "@/lib/constraints/graph";
import {
  applyTranscriptGrounding,
  snapHighlightsToTranscriptMatches,
  transcriptSignature
} from "./transcriptGrounding";
import { planSignaturePayload } from "@/lib/plan/normalize";
import { sha1String } from "@/lib/util/hash";
import { getPredictions, savePredictions, trimCache } from "@/lib/store/cache";
import { PLAN_DEFAULTS, REFRAME } from "@/lib/config";
import { planAnalysisBudget } from "@/lib/analysis/budget";
import type { AnalysisBudget, DeviceTier } from "@/lib/analysis/types";

/**
 * Fallback first-pass frame cap, used ONLY when no dynamic analysis budget is
 * available. The real cap is now DYNAMIC (see planAnalysisBudget): short
 * videos sample fewer frames, long videos get a larger (still bounded) coarse
 * scan. This constant remains as a safe backstop.
 */
const SOURCE_ANALYSIS_MAX_FRAMES = 240;

/** Map the existing capability tier to the analysis device tier. */
function capTierToDeviceTier(capTier: CapabilityTier): DeviceTier {
  if (capTier === "high") return "high";
  if (capTier === "mid") return "mid";
  if (capTier === "low") return "low";
  return "unknown";
}

/** Activity-log fan-out passed in by the orchestrator. */
export interface SourceLogger {
  ai: (kind: string, payload: Record<string, unknown>, summary?: string, ms?: number) => void;
  system: (kind: string, payload: Record<string, unknown>, summary?: string) => void;
}

export interface ProgressSink {
  setStatus: (s: string, detail?: string) => void;
  /** Progress within THIS source's run (0..1). The orchestrator scales it. */
  setProgress: (p: number) => void;
}

export interface ExecuteForSourceArgs {
  source: VideoSource;
  plan: EditPlan;
  mode: "plan" | "moment";
  capTier: CapabilityTier;
  userTier: UserTier;
  /** Optional local Whisper transcript for exact speech/text-grounded scoring. */
  transcript?: Transcript | null;
  /** v2.2 — Optional dynamic analysis budget. When omitted, a duration-aware
   *  budget is derived from the plan + capability tier (replaces the old
   *  flat 240-frame cap). */
  analysisBudget?: AnalysisBudget;
  log: SourceLogger;
  progress: ProgressSink;
}

export interface ExecuteForSourceResult {
  /** Highlights tagged with source.id and ready to merge globally. */
  highlights: Highlight[];
  /** True if the only matches were below the strong threshold. */
  weakOnly: boolean;
  /** Max composite score seen — used for "no strong matches" copy. */
  scoreMax: number;
  scoreStats: ScoreStats | null;
  /** Was the per-source predictions cache reused? */
  cacheHit: boolean;
}

/**
 * Run the full pipeline for one source. Throws on unrecoverable decoding errors;
 * returns an empty highlights array when nothing matched.
 */
export async function executeForSource(
  args: ExecuteForSourceArgs
): Promise<ExecuteForSourceResult> {
  const { source, plan, mode, capTier, userTier, transcript = null, log, progress } = args;
  const videoBlob = source.blob;
  const videoHash = source.hash;
  const videoMeta = {
    duration: source.meta.duration,
    width: source.meta.width,
    height: source.meta.height
  };

  // v2.2 — Dynamic analysis budget. Provided by the caller, or derived here
  // from the plan + capability tier so the coarse scan scales with video
  // length instead of a flat 240-frame cap (short → fewer, long → deeper but
  // still bounded). Describe/exact/control requests never reach this path.
  const analysisBudget: AnalysisBudget =
    args.analysisBudget ??
    planAnalysisBudget({
      durationSeconds: videoMeta.duration,
      width: videoMeta.width,
      height: videoMeta.height,
      sourceCount: 1,
      purpose: "normal_highlights",
      deviceTier: capTierToDeviceTier(capTier),
      hasCachedQuickScan: false,
      hasCachedDeepScan: false,
      userSpecifiedDuration: plan.userSpecifiedDuration,
      targetSeconds: plan.targetShortSeconds,
      promptSpecificity: "normal"
    });

  // ---- Cache lookup ------------------------------------------------
  // Transcript signature is part of the scoring cache key: a transcript-aware
  // run must not reuse older visual-only frame scores.
  const sig = await sha1String(
    `${planSignaturePayload(plan)}\n${transcriptSignature(transcript)}`
  );
  const cached = await getPredictions(videoHash, sig);
  let frameScores: FrameScore[];
  let cacheHit = false;

  if (cached) {
    log.system(
      "cache.hit",
      { sourceId: source.id, signature: sig.slice(0, 12), frames: cached.frames.length },
      `Cache hit on "${source.meta.name}" (${cached.frames.length} frames)`
    );
    frameScores = applyTranscriptGrounding(cached.frames, plan, transcript);
    progress.setStatus("scoring", `Reused cache for ${source.meta.name}`);
    progress.setProgress(0.5);
    cacheHit = true;
  } else {
    log.system(
      "cache.miss",
      {
        sourceId: source.id,
        signature: sig.slice(0, 12),
        transcriptGrounded: Boolean(transcript?.segments.length)
      },
      `Cache miss on "${source.meta.name}" — running fresh sample+score`
    );
    frameScores = await sampleAndScore({
      videoBlob,
      videoHash,
      scenarioSignature: sig,
      plan,
      transcript,
      capTier,
      videoMeta,
      analysisBudget,
      progress,
      log,
      sourceName: source.meta.name
    });
  }

  // ---- Time-bound filter ------------------------------------------
  if (plan.extractRange) {
    const r = plan.extractRange;
    const start =
      r.kind === "last"
        ? Math.max(0, videoMeta.duration - (r.endSeconds - r.startSeconds))
        : r.startSeconds;
    const end = r.kind === "last" ? videoMeta.duration : r.endSeconds;
    frameScores = frameScores.filter((f) => f.t >= start && f.t < end);
  }

  // ---- MOMENT mode -------------------------------------------------
  if (mode === "moment") {
    progress.setStatus("temporal", `Locating in ${source.meta.name}`);
    progress.setProgress(0.65);
    const t1 = Date.now();
    const buildResult = await buildMomentHighlight({
      videoBlob,
      frameScores,
      plan,
      videoDuration: videoMeta.duration,
      userTier,
      videoMeta,
      onProgress: (done, total) =>
        progress.setProgress(0.65 + (done / Math.max(total, 1)) * 0.3)
    });
    const grounded = snapHighlightsToTranscriptMatches(
      buildResult.highlights,
      plan,
      transcript,
      videoMeta.duration
    );
    const tagged = attachClipFocus(grounded, frameScores).map((h) => ({
      ...h,
      sourceId: source.id
    }));
    log.ai(
      "moment.localized",
      {
        sourceId: source.id,
        found: tagged.length > 0,
        count: tagged.length,
        weakOnly: buildResult.weakOnly,
        transcriptGrounded: Boolean(transcript?.segments.length),
        userTier
      },
      tagged.length > 0
        ? `Moment in "${source.meta.name}": ${tagged[0].start.toFixed(1)}s → ${tagged[0].end.toFixed(1)}s${buildResult.weakOnly ? " (low conf)" : ""}`
        : `Moment NOT found in "${source.meta.name}"`,
      Date.now() - t1
    );
    return {
      highlights: tagged,
      weakOnly: buildResult.weakOnly,
      scoreMax: tagged[0]?.score ?? 0,
      scoreStats: null,
      cacheHit
    };
  }

  // ---- PLAN mode ---------------------------------------------------
  progress.setStatus("temporal", `Finding events in ${source.meta.name}`);
  progress.setProgress(0.62);

  // ---- CONSTRAINT HARD GATE (v2.6) --------------------------------
  // For a constraint-driven plan ("only lab scenes", "avoid the intro"),
  // drop every frame that does not satisfy the constraint graph BEFORE any
  // candidate-window detection, ranking, or selection runs. From here on the
  // pipeline only ever sees constraint-passing frames, so no downstream
  // fallback can reintroduce excluded / off-constraint footage.
  if (plan.constraints && isConstraintDriven(plan.constraints)) {
    const before = frameScores.length;
    const { frames: gated, report } = applyConstraintFilter(
      frameScores,
      plan.constraints,
      {
        // Coverage-aware: when the user named a duration, let the gate relax
        // toward the noise floor so a constrained reel can approach the target
        // length using on-constraint footage only.
        targetSeconds: plan.userSpecifiedDuration ? plan.targetShortSeconds : null,
        sampleEverySeconds: plan.sampleEverySeconds
      }
    );
    frameScores = gated;
    log.ai(
      "constraints.filtered",
      {
        sourceId: source.id,
        inputFrames: before,
        keptFrames: report.keptCount,
        droppedByInclude: report.droppedByInclude,
        droppedByExclude: report.droppedByExclude,
        includeFloor: report.includeFloor,
        hardInclude: plan.constraints.include.some((c) => c.priority === "hard"),
        excludes: plan.constraints.exclude.length
      },
      report.keptCount > 0
        ? `Constraint gate kept ${report.keptCount}/${before} frames from "${source.meta.name}" (dropped ${report.droppedByInclude} off-topic, ${report.droppedByExclude} excluded)`
        : `Constraint gate removed all ${before} frames from "${source.meta.name}" — no footage matched the constraints`
    );
    if (frameScores.length === 0) {
      // Honest empty result — NEVER fall back to generic highlights when the
      // constraint produced nothing. The caller surfaces "no matching footage".
      return {
        highlights: [],
        weakOnly: false,
        scoreMax: 0,
        scoreStats: null,
        cacheHit
      };
    }
  }

  const detectionResult = detectCandidateWindows(frameScores, plan, {
    userTier,
    videoMeta
  });
  const candidates = detectionResult.windows;
  const scoreStats = detectionResult.stats;

  log.ai(
    "events.detected",
    {
      sourceId: source.id,
      candidateCount: candidates.length,
      framesScored: frameScores.length,
      userTier,
      percentile: detectionResult.percentile,
      cutoff: round2(detectionResult.cutoff),
      scoreMax: round2(scoreStats.max),
      scoreMean: round2(scoreStats.mean),
      transcriptGrounded: Boolean(transcript?.segments.length)
    },
    `${candidates.length} candidates from "${source.meta.name}" (top ${(detectionResult.percentile * 100).toFixed(0)}%)`
  );

  if (candidates.length === 0) {
    return { highlights: [], weakOnly: false, scoreMax: scoreStats.max, scoreStats, cacheHit };
  }

  const t2 = Date.now();
  const verdicts = await runTemporalPass({
    videoBlob,
    candidates,
    plan,
    onProgress: (done, total) =>
      progress.setProgress(0.65 + (done / Math.max(total, 1)) * 0.25)
  });

  progress.setStatus("selecting", `Picking from ${source.meta.name}`);
  progress.setProgress(0.92);
  const buildResult = buildHighlights({
    candidates,
    verdicts,
    plan,
    videoDuration: videoMeta.duration,
    userTier,
    scoreStats
    // NOTE: for a constraint-driven plan the candidate windows here are
    // ALREADY constraint-filtered (the hard gate ran on the frames above), so
    // the duration-fill / spread fallbacks inside buildHighlights can only ever
    // draw from on-constraint footage. (Disabling them entirely was what
    // collapsed a 60s "only lab" request to a single 1s clip.)
  });
  const grounded = snapHighlightsToTranscriptMatches(
    buildResult.highlights,
    plan,
    transcript,
    videoMeta.duration
  );
  const tagged = attachClipFocus(grounded, frameScores).map((h) => ({
    ...h,
    sourceId: source.id
  }));

  log.ai(
    "highlights.built",
    {
      sourceId: source.id,
      count: tagged.length,
      totalSeconds: round2(tagged.reduce((acc, h) => acc + (h.end - h.start), 0)),
      weakOnly: buildResult.weakOnly,
      transcriptGrounded: Boolean(transcript?.segments.length),
      userTier
    },
    `Built ${tagged.length} clip${tagged.length === 1 ? "" : "s"} from "${source.meta.name}"`,
    Date.now() - t2
  );

  return {
    highlights: tagged,
    weakOnly: buildResult.weakOnly,
    scoreMax: scoreStats.max,
    scoreStats,
    cacheHit
  };
}

// ---------------------------------------------------------------------
// Internal: cache-miss sample + score branch.
// ---------------------------------------------------------------------

async function sampleAndScore(args: {
  videoBlob: Blob;
  videoHash: string;
  scenarioSignature: string;
  plan: EditPlan;
  transcript?: Transcript | null;
  capTier: CapabilityTier;
  videoMeta: { duration: number; width: number; height: number };
  analysisBudget: AnalysisBudget;
  progress: ProgressSink;
  log: SourceLogger;
  sourceName: string;
}): Promise<FrameScore[]> {
  const {
    videoBlob,
    videoHash,
    scenarioSignature,
    plan,
    transcript = null,
    capTier,
    videoMeta,
    analysisBudget,
    progress,
    log,
    sourceName
  } = args;
  progress.setStatus("sampling", `Extracting frames from ${sourceName}`);

  const tA = Date.now();
  const range = plan.extractRange
    ? plan.extractRange.kind === "last"
      ? {
          startSeconds: Math.max(
            0,
            videoMeta.duration -
              (plan.extractRange.endSeconds - plan.extractRange.startSeconds)
          ),
          endSeconds: videoMeta.duration
        }
      : {
          startSeconds: plan.extractRange.startSeconds,
          endSeconds: plan.extractRange.endSeconds
        }
    : undefined;
  const sampling = computeAdaptiveSampling(plan, videoMeta.duration, analysisBudget, range);
  const frames = await sampleFrames(videoBlob, {
    every: sampling.everySeconds,
    width: plan.inferenceWidth,
    maxFrames: sampling.maxFrames,
    range,
    onProgress: (pp) => progress.setProgress(0.05 + pp * 0.2)
  });
  log.ai(
    "frames.sampled",
    {
      count: frames.length,
      everySeconds: sampling.everySeconds,
      requestedEverySeconds: plan.sampleEverySeconds,
      widthPx: plan.inferenceWidth,
      maxFrames: sampling.maxFrames,
      adaptive: sampling.adaptive
    },
    sampling.adaptive
      ? `Sampled ${frames.length} frames from ${sourceName} at ${sampling.everySeconds.toFixed(2)}s intervals (adaptive cap)`
      : `Sampled ${frames.length} frames from ${sourceName}`,
    Date.now() - tA
  );

  progress.setStatus("scoring", `Scoring ${frames.length} frames (${capTier})`);
  const tier = capTier === "low" ? "cloud" : "siglip-local";
  const tB = Date.now();
  const visualScores = await scoreFrames({
    frames,
    plan,
    tier,
    onProgress: (done, total) => progress.setProgress(0.25 + (done / total) * 0.35)
  });
  const scored = applyTranscriptGrounding(visualScores, plan, transcript);
  log.ai(
    "frames.scored",
    {
      count: scored.length,
      tier,
      cacheHit: false,
      transcriptGrounded: Boolean(transcript?.segments.length)
    },
    `Scored ${scored.length} frames via ${tier}${transcript?.segments.length ? " + transcript" : ""}`,
    Date.now() - tB
  );

  await savePredictions({
    videoHash,
    scenarioSignature,
    sampleEverySeconds: sampling.everySeconds,
    frames: scored,
    createdAt: Date.now()
  });
  await trimCache();
  return scored;
}

function computeAdaptiveSampling(
  plan: EditPlan,
  videoDuration: number,
  budget: AnalysisBudget,
  range?: { startSeconds: number; endSeconds: number }
): {
  everySeconds: number;
  maxFrames: number;
  adaptive: boolean;
} {
  // v2.2 — the cap is the dynamic budget's maxFrames (duration + device aware),
  // falling back to the flat backstop only if the budget yielded 0 frames.
  const maxFrames = budget.maxFrames > 0 ? budget.maxFrames : SOURCE_ANALYSIS_MAX_FRAMES;
  const start = range ? Math.max(0, range.startSeconds) : 0;
  const end = range
    ? Math.max(start, Math.min(videoDuration, range.endSeconds))
    : videoDuration;
  const windowSeconds = Math.max(0, end - start);
  const requestedEvery = Math.max(0.25, plan.sampleEverySeconds);
  if (windowSeconds <= 0 || maxFrames <= 0) {
    return { everySeconds: requestedEvery, maxFrames, adaptive: false };
  }
  const cappedEvery = windowSeconds / maxFrames;
  const everySeconds = Math.max(requestedEvery, cappedEvery);
  return {
    everySeconds: round2(everySeconds),
    maxFrames,
    adaptive: everySeconds > requestedEvery
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * v2.7 — Attach a smart-reframe focal point to each clip by aggregating its
 * frames' per-frame focal points, weighted by motion (action frames dominate)
 * plus a small base weight so static frames still count. Drives the
 * vertical/square crop position so it sits on the subject, not the frame
 * center. Frames carry focusX/focusY from the sampler; absent → 0.5 (center).
 */
function attachClipFocus(highlights: Highlight[], frames: FrameScore[]): Highlight[] {
  if (frames.length === 0) return highlights;
  return highlights.map((h) => {
    let wx = 0;
    let wy = 0;
    let wsum = 0;
    for (const f of frames) {
      if (f.t < h.start || f.t > h.end) continue;
      const fx = f.focusX ?? 0.5;
      const fy = f.focusY ?? 0.5;
      const wgt = (f.motion ?? 0) + REFRAME.clipMotionBaseWeight;
      wx += fx * wgt;
      wy += fy * wgt;
      wsum += wgt;
    }
    if (wsum <= 0) return h;
    return { ...h, focusX: round2(wx / wsum), focusY: round2(wy / wsum) };
  });
}

/**
 * Merge highlights from multiple sources into one global timeline.
 */
export function mergeAcrossSources(
  perSource: ExecuteForSourceResult[],
  plan: EditPlan,
  mode: "plan" | "moment"
): { highlights: Highlight[]; weakOnly: boolean; scoreMax: number } {
  const all = perSource.flatMap((r) => r.highlights);
  const scoreMax = perSource.reduce((acc, r) => Math.max(acc, r.scoreMax), 0);
  const weakOnly =
    perSource.length > 0 && perSource.every((r) => r.weakOnly || r.highlights.length === 0);

  if (all.length === 0) {
    return { highlights: [], weakOnly, scoreMax };
  }

  if (mode === "moment") {
    const winner = [...all].sort((a, b) => b.score - a.score)[0];
    return { highlights: [winner], weakOnly, scoreMax };
  }

  // No-duration plan mode: no clip-count limit. Keep all non-overlapping clips
  // that fit inside the total-duration guard so "pick best parts" is governed
  // by source content instead of a hardcoded count like 12.
  if (!plan.userSpecifiedDuration) {
    const ranked = [...all].sort((a, b) => b.score - a.score);
    const out: Highlight[] = [];
    let total = 0;
    for (const h of ranked) {
      const dur = h.end - h.start;
      if (total + dur > PLAN_DEFAULTS.maxTotalSecondsWithoutBudget) continue;
      const overlap = out.find((x) => {
        if ((x.sourceId ?? null) !== (h.sourceId ?? null)) return false;
        const o = Math.max(0, Math.min(x.end, h.end) - Math.max(x.start, h.start));
        return o / Math.max(dur, 0.001) > 0.5;
      });
      if (overlap) continue;
      out.push(h);
      total += dur;
    }
    out.sort((a, b) => {
      const sa = a.sourceId ?? "";
      const sb = b.sourceId ?? "";
      if (sa !== sb) return sa.localeCompare(sb);
      return a.start - b.start;
    });
    return { highlights: out, weakOnly, scoreMax };
  }

  // ---------- Budgeted path ----------
  const budget = plan.targetShortSeconds;
  const sorted = [...all].sort((a, b) => b.score - a.score);

  let chosen: Highlight[];
  if (plan.selectionStrategy === "balanced") {
    const bySource = new Map<string, Highlight[]>();
    for (const h of sorted) {
      const k = h.sourceId ?? "_";
      if (!bySource.has(k)) bySource.set(k, []);
      bySource.get(k)!.push(h);
    }
    const queues = Array.from(bySource.values());
    chosen = [];
    let total = 0;
    let any = true;
    while (any && total < budget) {
      any = false;
      for (const q of queues) {
        if (q.length === 0) continue;
        const next = q.shift()!;
        chosen.push(next);
        total += next.end - next.start;
        any = true;
        if (total >= budget) break;
      }
    }
  } else {
    chosen = [];
    let total = 0;
    for (const h of sorted) {
      if (total >= budget) break;
      chosen.push(h);
      total += h.end - h.start;
    }
  }

  chosen.sort((a, b) => {
    const sa = a.sourceId ?? "";
    const sb = b.sourceId ?? "";
    if (sa !== sb) return sa.localeCompare(sb);
    return a.start - b.start;
  });

  return { highlights: chosen, weakOnly, scoreMax };
}

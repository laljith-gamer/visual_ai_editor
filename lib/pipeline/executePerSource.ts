/**
 * v1.6.0 — Per-source pipeline execution.
 *
 * Runs the full sample → score → temporal → buildHighlights flow
 * for ONE video source and returns the resulting highlights tagged
 * with the source's id. The orchestrator (in app/page.tsx) calls this
 * once per eligible library source and merges the outputs.
 *
 * This is a pure-data helper: it takes everything it needs as
 * arguments and returns a structured result. It does NOT call
 * setHighlights, pushMessage, or any other store mutation — those
 * belong to the orchestrator so it can reason globally about budget,
 * messaging, and progress.
 *
 * The body is the verbatim logic that lived inline in runPipeline
 * pre-v1.6.0; only the data plumbing changed.
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
import { sampleFrames } from "./sample";
import { scoreFrames } from "./score";
import { detectCandidateWindows } from "./events";
import { runTemporalPass } from "./temporal";
import { buildHighlights } from "./highlights";
import { buildMomentHighlight } from "./moment";
import { planSignaturePayload } from "@/lib/plan/normalize";
import { sha1String } from "@/lib/util/hash";
import { getPredictions, savePredictions, trimCache } from "@/lib/store/cache";
import { SAMPLE_DEFAULTS } from "@/lib/config";

/** Activity-log fan-out passed in by the orchestrator. */
export interface SourceLogger {
  ai: (kind: string, payload: Record<string, unknown>, summary?: string, ms?: number) => void;
  system: (kind: string, payload: Record<string, unknown>, summary?: string) => void;
}

export interface ProgressSink {
  setStatus: (s: string, detail?: string) => void;
  /** Progress within THIS source's run (0..1). The orchestrator scales
   *  it to global progress. */
  setProgress: (p: number) => void;
}

export interface ExecuteForSourceArgs {
  source: VideoSource;
  plan: EditPlan;
  mode: "plan" | "moment";
  capTier: CapabilityTier;
  userTier: UserTier;
  log: SourceLogger;
  progress: ProgressSink;
}

export interface ExecuteForSourceResult {
  /** Highlights tagged with source.id and ready to merge globally. */
  highlights: Highlight[];
  /** True if the only matches were below the strong threshold; the
   *  orchestrator may want to qualify the assistant message. */
  weakOnly: boolean;
  /** Max composite score seen — used for "no strong matches" copy. */
  scoreMax: number;
  scoreStats: ScoreStats | null;
  /** Was the per-source predictions cache reused? */
  cacheHit: boolean;
}

/**
 * Run the full pipeline for one source. Throws on unrecoverable
 * decoding errors; returns an empty `highlights` array when nothing
 * matched (the orchestrator decides whether to surface that).
 */
export async function executeForSource(
  args: ExecuteForSourceArgs
): Promise<ExecuteForSourceResult> {
  const { source, plan, mode, capTier, userTier, log, progress } = args;
  const videoBlob = source.blob;
  const videoHash = source.hash;
  const videoMeta = {
    duration: source.meta.duration,
    width: source.meta.width,
    height: source.meta.height
  };

  // ---- Cache lookup ------------------------------------------------
  const sig = await sha1String(planSignaturePayload(plan));
  const cached = await getPredictions(videoHash, sig);
  let frameScores: FrameScore[];
  let cacheHit = false;

  if (cached) {
    log.system(
      "cache.hit",
      { sourceId: source.id, signature: sig.slice(0, 12), frames: cached.frames.length },
      `Cache hit on "${source.meta.name}" (${cached.frames.length} frames)`
    );
    frameScores = cached.frames;
    progress.setStatus("scoring", `Reused cache for ${source.meta.name}`);
    progress.setProgress(0.5);
    cacheHit = true;
  } else {
    log.system(
      "cache.miss",
      { sourceId: source.id, signature: sig.slice(0, 12) },
      `Cache miss on "${source.meta.name}" — running fresh sample+score`
    );
    frameScores = await sampleAndScore({
      videoBlob,
      videoHash,
      plan,
      capTier,
      videoMeta,
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
    const tagged = buildResult.highlights.map((h) => ({
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
      scoreMean: round2(scoreStats.mean)
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
  });
  const tagged = buildResult.highlights.map((h) => ({
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
  plan: EditPlan;
  capTier: CapabilityTier;
  videoMeta: { duration: number; width: number; height: number };
  progress: ProgressSink;
  log: SourceLogger;
  sourceName: string;
}): Promise<FrameScore[]> {
  const { videoBlob, videoHash, plan, capTier, videoMeta, progress, log, sourceName } = args;
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
  const sampling = computeAdaptiveSampling(plan, videoMeta.duration, range);
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
  const scored = await scoreFrames({
    frames,
    plan,
    tier,
    onProgress: (done, total) => progress.setProgress(0.25 + (done / total) * 0.35)
  });
  log.ai(
    "frames.scored",
    { count: scored.length, tier, cacheHit: false },
    `Scored ${scored.length} frames via ${tier}`,
    Date.now() - tB
  );

  await savePredictions({
    videoHash,
    scenarioSignature: await sha1String(planSignaturePayload(plan)),
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
  range?: { startSeconds: number; endSeconds: number }
): {
  everySeconds: number;
  maxFrames: number;
  adaptive: boolean;
} {
  const maxFrames = SAMPLE_DEFAULTS.maxFrames;
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
 * Merge highlights from multiple sources into one global timeline.
 *
 * v1.6.0 default policy ("time-fused"):
 *   1. Sort all candidates by composite score, descending.
 *   2. Keep greedily until the global duration budget is full.
 *   3. Sort final clips chronologically for a watchable output.
 *
 * This keeps the selection simple and deterministic. A future "balanced"
 * global strategy can reserve slots per source when product requirements
 * demand equal representation.
 */
export function mergeSourceHighlights(
  results: Array<{ source: VideoSource; highlights: Highlight[] }>,
  plan: EditPlan
): Highlight[] {
  const all = results.flatMap((r) =>
    r.highlights.map((h) => ({
      ...h,
      sourceId: h.sourceId ?? r.source.id
    }))
  );
  if (all.length === 0) return [];

  const sorted = [...all].sort((a, b) => b.score - a.score);
  const selected: Highlight[] = [];
  let total = 0;

  for (const h of sorted) {
    const dur = h.end - h.start;
    if (total + dur > plan.targetShortSeconds && selected.length > 0) continue;
    selected.push(h);
    total += dur;
    if (total >= plan.targetShortSeconds) break;
  }

  return selected.sort((a, b) => a.start - b.start);
}

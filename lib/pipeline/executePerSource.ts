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
import {
  applyTranscriptGrounding,
  snapHighlightsToTranscriptMatches,
  transcriptSignature
} from "./transcriptGrounding";
import { planSignaturePayload } from "@/lib/plan/normalize";
import { sha1String } from "@/lib/util/hash";
import { getPredictions, savePredictions, trimCache } from "@/lib/store/cache";
import { PLAN_DEFAULTS } from "@/lib/config";

/**
 * Production guardrail for the first-pass frame scorer.
 *
 * This is a sampling cap, not an output-clip cap. Long videos are represented
 * by a bounded, evenly spread coarse pass instead of thousands of frames.
 */
const SOURCE_ANALYSIS_MAX_FRAMES = 240;

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
    const tagged = grounded.map((h) => ({
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
  });
  const grounded = snapHighlightsToTranscriptMatches(
    buildResult.highlights,
    plan,
    transcript,
    videoMeta.duration
  );
  const tagged = grounded.map((h) => ({
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
  range?: { startSeconds: number; endSeconds: number }
): {
  everySeconds: number;
  maxFrames: number;
  adaptive: boolean;
} {
  const maxFrames = SOURCE_ANALYSIS_MAX_FRAMES;
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

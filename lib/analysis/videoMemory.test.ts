import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createVideoMemory,
  mergeVideoMemory,
  needsAnalysisLevel,
  summarizeVideoMemory,
  summarizeSourceForPlanning,
  motionProfile
} from "./videoMemory.ts";
import type { VideoAnalysisMemory } from "./types.ts";

function base(): VideoAnalysisMemory {
  return createVideoMemory({
    videoHash: "h1",
    sourceId: "src_a",
    sourceName: "clip.mp4",
    durationSeconds: 125,
    width: 1080,
    height: 1920,
    updatedAt: 1000
  });
}

test("createVideoMemory starts at level 0 with no raw frame data", () => {
  const m = base();
  assert.equal(m.level, 0);
  assert.equal(m.keyframes.length, 0);
  assert.equal(m.knownGoodWindows.length, 0);
  // No place for raw bytes — only compact fields exist.
  assert.equal(typeof (m as unknown as { blob?: unknown }).blob, "undefined");
});

test("mergeVideoMemory upgrades a lower level with a higher one", () => {
  const m = base();
  const merged = mergeVideoMemory(m, {
    level: 2,
    confidence: 0.7,
    sceneMap: [{ start: 0, end: 60 }, { start: 60, end: 125 }],
    motionPeaks: [{ start: 10, end: 14, score: 0.8 }],
    updatedAt: 2000
  });
  assert.equal(merged.level, 2);
  assert.equal(merged.confidence, 0.7);
  assert.equal(merged.sceneMap.length, 2);
  assert.equal(merged.updatedAt, 2000);
});

test("mergeVideoMemory never downgrades the level", () => {
  const m = { ...base(), level: 3 as const };
  const merged = mergeVideoMemory(m, { level: 1 });
  assert.equal(merged.level, 3);
});

test("needsAnalysisLevel reflects stored level", () => {
  const m = mergeVideoMemory(base(), { level: 1 });
  assert.equal(needsAnalysisLevel(m, 1), false);
  assert.equal(needsAnalysisLevel(m, 2), true);
  assert.equal(needsAnalysisLevel(null, 1), true);
  assert.equal(needsAnalysisLevel(null, 0), false);
});

test("motionProfile classifies high vs low", () => {
  const high = mergeVideoMemory(base(), { level: 1, motionPeaks: [{ start: 0, end: 5, score: 0.9 }] });
  assert.equal(motionProfile(high), "high");
  const low = mergeVideoMemory(base(), { level: 1, staticRanges: [{ start: 0, end: 100, score: 0.1 }] });
  assert.equal(motionProfile(low), "low");
  assert.equal(motionProfile(base()), "unknown"); // level 0
});

test("summarizeVideoMemory is a short human string", () => {
  const m = mergeVideoMemory(base(), { level: 2, sceneMap: [{ start: 0, end: 60 }], knownGoodWindows: [{ start: 10, end: 18, score: 0.8 }] });
  const s = summarizeVideoMemory(m);
  assert.match(s, /clip\.mp4/);
  assert.match(s, /2:05/);
  assert.match(s, /scan level 2/);
});

test("summarizeSourceForPlanning reduces to a compact planning summary", () => {
  const m = mergeVideoMemory(base(), {
    level: 2,
    sourceRole: "main action",
    knownGoodWindows: [{ start: 10, end: 18, score: 0.8 }, { start: 40, end: 48, score: 0.7 }]
  });
  const p = summarizeSourceForPlanning(m);
  assert.equal(p.sourceId, "src_a");
  assert.equal(p.videoHash, "h1");
  assert.equal(p.goodWindowCount, 2);
  assert.equal(p.role, "main action");
});

test("re-upload reuse: a fresh source id keeps the same hash-keyed memory shape", () => {
  // The store keys by hash; merging a patch with a new sourceId keeps hash.
  const m = base();
  const merged = mergeVideoMemory(m, { sourceId: "src_b", level: 1 });
  assert.equal(merged.videoHash, "h1");
  assert.equal(merged.sourceId, "src_b");
});

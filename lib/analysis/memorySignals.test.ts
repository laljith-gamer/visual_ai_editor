// Tests for the pure memory-signal bridge helpers.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  analysisCacheSignals,
  analysisLevelForRun,
  buildHighlightMemoryPatch
} from "./memorySignals.ts";
import { createVideoMemory, mergeVideoMemory } from "./videoMemory.ts";

const mem = (level: number) =>
  mergeVideoMemory(
    createVideoMemory({ videoHash: "h", sourceId: "s", sourceName: "n", durationSeconds: 60, updatedAt: 1 }),
    { level: level as 0 | 1 | 2 | 3 | 4, updatedAt: 1 }
  );

test("null memory → no cache signals", () => {
  assert.deepEqual(analysisCacheSignals(null), { hasCachedQuickScan: false, hasCachedDeepScan: false });
});

test("level 1 memory → quick cache true, deep cache false", () => {
  assert.deepEqual(analysisCacheSignals(mem(1)), { hasCachedQuickScan: true, hasCachedDeepScan: false });
});

test("level 3 memory → quick AND deep cache true", () => {
  assert.deepEqual(analysisCacheSignals(mem(3)), { hasCachedQuickScan: true, hasCachedDeepScan: true });
});

test("level for run: semantic pass → 3, structural → 2", () => {
  assert.equal(analysisLevelForRun({ hadSemanticPass: true }), 3);
  assert.equal(analysisLevelForRun({ hadSemanticPass: false }), 2);
});

test("highlight memory patch records kept clips as knownGoodWindows", () => {
  const patch = buildHighlightMemoryPatch({
    durationSeconds: 120,
    highlights: [
      { start: 1, end: 4, score: 0.8 },
      { start: 10, end: 13, score: 0.7 }
    ],
    scoreMax: 0.8,
    weakOnly: false,
    hadSemanticPass: true,
    updatedAt: 5
  });
  assert.equal(patch.level, 3);
  assert.equal(patch.knownGoodWindows?.length, 2);
  assert.equal(patch.weakWindows?.length, 0);
  assert.ok((patch.confidence ?? 0) > 0.5);
});

test("weak run records windows as weakWindows + softened confidence", () => {
  const patch = buildHighlightMemoryPatch({
    durationSeconds: 120,
    highlights: [{ start: 1, end: 4, score: 0.6 }],
    scoreMax: 0.6,
    weakOnly: true,
    hadSemanticPass: false
  });
  assert.equal(patch.level, 2);
  assert.equal(patch.knownGoodWindows?.length, 0);
  assert.equal(patch.weakWindows?.length, 1);
  assert.ok((patch.confidence ?? 1) <= 0.3 + 1e-9);
});

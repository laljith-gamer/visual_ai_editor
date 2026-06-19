// Tests for the dynamic analysis budget planner. Frame counts are upper
// bounds driven by purpose + duration + device tier + cache — never a single
// fixed 240 cap.

import { test } from "node:test";
import assert from "node:assert/strict";

import { planAnalysisBudget } from "./budget.ts";
import type { AnalysisBudgetInput } from "./types.ts";

const base = (over: Partial<AnalysisBudgetInput> = {}): AnalysisBudgetInput => ({
  durationSeconds: 120,
  sourceCount: 1,
  purpose: "normal_highlights",
  deviceTier: "high",
  hasCachedQuickScan: false,
  hasCachedDeepScan: false,
  promptSpecificity: "normal",
  ...over
});

// ---- exact / read-only / merge → 0 frames ----------------------------
test("exact edit / control (purpose none) → 0 frames, no AI", () => {
  const b = planAnalysisBudget(base({ purpose: "none" }));
  assert.equal(b.maxFrames, 0);
  assert.equal(b.allowSemanticPass, false);
  assert.equal(b.allowDenseWindowPass, false);
});

test("transcript search → 0 frames (uses transcript, not vision)", () => {
  const b = planAnalysisBudget(base({ purpose: "transcript_search" }));
  assert.equal(b.maxFrames, 0);
  assert.equal(b.allowSemanticPass, false);
});

// ---- quick describe → small frame count ------------------------------
test("quick describe → small keyframe count (5..12), no semantic pass", () => {
  const b = planAnalysisBudget(base({ purpose: "quick_describe", durationSeconds: 120 }));
  assert.ok(b.maxFrames >= 5 && b.maxFrames <= 12, `frames=${b.maxFrames}`);
  assert.equal(b.allowSemanticPass, false);
});

test("quick describe on a 5s clip stays tiny (does not force the band min)", () => {
  const b = planAnalysisBudget(base({ purpose: "quick_describe", durationSeconds: 5 }));
  assert.ok(b.maxFrames <= 5, `frames=${b.maxFrames}`);
  assert.ok(b.maxFrames >= 1);
});

// ---- short video best parts → light scan -----------------------------
test("short video best parts → 24..80 band (light scan)", () => {
  const b = planAnalysisBudget(base({ purpose: "normal_highlights", durationSeconds: 25 }));
  assert.ok(b.maxFrames <= 80, `frames=${b.maxFrames}`);
});

// ---- long video → larger but capped budget + coarse-to-fine ----------
test("long video gets a larger but capped budget and enables dense windows", () => {
  const b = planAnalysisBudget(base({ purpose: "normal_highlights", durationSeconds: 1800 }));
  assert.ok(b.maxFrames > 180, `frames=${b.maxFrames}`);
  assert.ok(b.maxFrames <= 360, `frames=${b.maxFrames}`);
  assert.equal(b.allowDenseWindowPass, true);
  assert.ok(b.maxCandidateWindows > 0);
});

test("a 5-second video never gets 240 frames", () => {
  const b = planAnalysisBudget(base({ purpose: "normal_highlights", durationSeconds: 5 }));
  assert.ok(b.maxFrames < 240, `frames=${b.maxFrames}`);
  assert.ok(b.maxFrames <= 10);
});

// ---- device tier shifts the ceiling ----------------------------------
test("low device tier gets fewer frames than high tier (same request)", () => {
  const high = planAnalysisBudget(base({ durationSeconds: 1800, deviceTier: "high" }));
  const low = planAnalysisBudget(base({ durationSeconds: 1800, deviceTier: "low" }));
  assert.ok(low.maxFrames < high.maxFrames, `low=${low.maxFrames} high=${high.maxFrames}`);
});

// ---- cache reduces work ----------------------------------------------
test("a cached deep scan reduces new sampling to 0 for best-parts", () => {
  const b = planAnalysisBudget(base({ purpose: "normal_highlights", hasCachedDeepScan: true }));
  assert.equal(b.maxFrames, 0);
  // selection can still proceed from cached scores
  assert.equal(b.allowSemanticPass, true);
});

test("a cached quick scan lets describe reuse it (0 new frames)", () => {
  const b = planAnalysisBudget(base({ purpose: "quick_describe", hasCachedQuickScan: true }));
  assert.equal(b.maxFrames, 0);
});

// ---- specific visual search → coarse first, deep on candidates -------
test("specific visual search enables semantic + dense window passes", () => {
  const b = planAnalysisBudget(base({ purpose: "specific_visual_search", durationSeconds: 300 }));
  assert.equal(b.allowSemanticPass, true);
  assert.equal(b.allowDenseWindowPass, true);
  assert.ok(b.denseFramesPerWindow > 0);
  assert.ok(b.maxCandidateWindows > 0);
});

// ---- never default to a full deep scan for a vague best-parts ask -----
test("vague best-parts on a medium video does not request the deep-scan max", () => {
  const b = planAnalysisBudget(base({ purpose: "normal_highlights", durationSeconds: 120, promptSpecificity: "vague" }));
  assert.ok(b.maxFrames <= 180, `frames=${b.maxFrames}`);
});

test("sampleEverySeconds is positive whenever frames are sampled", () => {
  const b = planAnalysisBudget(base({ purpose: "normal_highlights", durationSeconds: 600 }));
  assert.ok(b.maxFrames > 0);
  assert.ok(b.sampleEverySeconds > 0);
});

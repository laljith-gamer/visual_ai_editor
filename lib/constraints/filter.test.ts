// =====================================================================
// Tests for the constraint HARD GATE (lib/constraints/filter.ts).
//
// These prove the acceptance criteria:
//   - "only lab scenes" → ONLY lab frames survive (before scoring).
//   - "only driving" / "only talking head" → same, generically.
//   - excludes drop matching footage semantically (via SigLIP label scores).
//   - weak-but-clear matches survive; coverage relaxes toward a target.
//   - soft / no-constraint graphs pass through untouched.
//
// Run via the agentic-layer runner (Node --test + --experimental-strip-types
// + the ts-ext hook).
// =====================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildConstraintGraph } from "./graph.ts";
import { applyConstraintFilter } from "./filter.ts";

// Build a minimal FrameScore. `labels` maps scenarioId → SigLIP score.
function frame(t: number, labels: Record<string, number>, semantic = 0) {
  return { t, score: semantic, semantic, motion: 0, saliency: 0, labels };
}

// ---------------------------------------------------------------------
// "only lab scenes, ignore everything else" → ONLY lab frames survive
// ---------------------------------------------------------------------
test("only lab scenes: gate keeps lab frames, drops everything else", () => {
  const { graph } = buildConstraintGraph({
    scenarios: [{ id: "lab", prompt: "laboratory interior with equipment" }],
    exclusiveOnly: true
  });

  const frames = [
    frame(0, { lab: 0.82 }), // lab
    frame(1, { lab: 0.05 }), // outdoor
    frame(2, { lab: 0.78 }), // lab
    frame(3, { lab: 0.10 }), // face cam
    frame(4, { lab: 0.91 }), // lab
    frame(5, { lab: 0.12 }) // hallway
  ];

  const { frames: kept, report } = applyConstraintFilter(frames, graph);
  assert.equal(report.hardApplied, true);
  assert.equal(kept.length, 3);
  // Every surviving frame is a lab frame.
  for (const f of kept) assert.ok(f.labels.lab >= 0.5, `t=${f.t} not lab`);
  assert.deepEqual(kept.map((f) => f.t), [0, 2, 4]);
  assert.equal(report.droppedByInclude, 3);
  assert.equal(report.droppedByExclude, 0);
});

test("only driving segments: gate keeps only driving frames", () => {
  const { graph } = buildConstraintGraph({
    scenarios: [{ id: "driving", prompt: "view from a moving car driving on a road" }],
    exclusiveOnly: true
  });
  const frames = [
    frame(0, { driving: 0.7 }),
    frame(1, { driving: 0.08 }),
    frame(2, { driving: 0.66 }),
    frame(3, { driving: 0.2 })
  ];
  const { frames: kept } = applyConstraintFilter(frames, graph);
  assert.deepEqual(kept.map((f) => f.t), [0, 2]);
});

test("only talking-head moments: gate keeps only talking-head frames", () => {
  const { graph } = buildConstraintGraph({
    scenarios: [{ id: "talk", prompt: "person talking to camera, head and shoulders" }],
    exclusiveOnly: true
  });
  const frames = [
    frame(0, { talk: 0.1 }),
    frame(1, { talk: 0.85 }),
    frame(2, { talk: 0.9 }),
    frame(3, { talk: 0.05 })
  ];
  const { frames: kept } = applyConstraintFilter(frames, graph);
  assert.deepEqual(kept.map((f) => f.t), [1, 2]);
});

// ---------------------------------------------------------------------
// Filtering happens BEFORE scoring: a high-motion off-constraint frame is
// removed even though its composite score would have ranked it highly.
// ---------------------------------------------------------------------
test("a high-score off-constraint frame is still dropped by the gate", () => {
  const { graph } = buildConstraintGraph({
    scenarios: [{ id: "lab", prompt: "lab" }],
    exclusiveOnly: true
  });
  const frames = [
    frame(0, { lab: 0.8 }, 0.8),
    // Visually busy, high composite score, but NOT a lab → must be dropped.
    frame(1, { lab: 0.05 }, 0.99)
  ];
  const { frames: kept } = applyConstraintFilter(frames, graph);
  assert.deepEqual(kept.map((f) => f.t), [0]);
});

// ---------------------------------------------------------------------
// Excludes — semantic, via the weight-0 exclude scenario's score
// ---------------------------------------------------------------------
test("exclude: frames matching the excluded concept are removed", () => {
  const { graph, excludeScenarios } = buildConstraintGraph({
    scenarios: [{ id: "cooking", prompt: "cooking moments" }],
    exclusiveOnly: false,
    excludeSubjects: ["intro"]
  });
  const excId = excludeScenarios[0].id;
  const frames = [
    frame(0, { cooking: 0.6, [excId]: 0.02 }), // cooking, not intro
    frame(1, { cooking: 0.3, [excId]: 0.7 }), // intro card → excluded
    frame(2, { cooking: 0.5, [excId]: 0.0 }) // cooking
  ];
  const { frames: kept, report } = applyConstraintFilter(frames, graph);
  assert.deepEqual(kept.map((f) => f.t), [0, 2]);
  assert.equal(report.droppedByExclude, 1);
});

// ---------------------------------------------------------------------
// Empty result is honest — never widened
// ---------------------------------------------------------------------
test("when nothing matches a hard include, the gate returns empty (no widening)", () => {
  const { graph } = buildConstraintGraph({
    scenarios: [{ id: "lab", prompt: "lab" }],
    exclusiveOnly: true
  });
  const frames = [frame(0, { lab: 0.05 }), frame(1, { lab: 0.08 })];
  const { frames: kept, report } = applyConstraintFilter(frames, graph);
  assert.equal(kept.length, 0);
  assert.equal(report.hardApplied, true);
});

// ---------------------------------------------------------------------
// REGRESSION (the "1s clip" bug): weak-but-clear matches must survive.
// SigLIP zero-shot scores for a true match commonly sit ~0.30. A fixed
// 0.32 floor dropped them all and collapsed the reel to one forced clip.
// The adaptive gate keeps them because they stand out from the background.
// ---------------------------------------------------------------------
test("weak-but-clear lab frames (~0.30) survive the adaptive gate", () => {
  const { graph } = buildConstraintGraph({
    scenarios: [{ id: "lab", prompt: "a person in a laboratory" }],
    exclusiveOnly: true
  });
  const frames = [
    frame(0, { lab: 0.31 }),
    frame(1, { lab: 0.05 }), // clearly not lab → drop
    frame(2, { lab: 0.29 }),
    frame(3, { lab: 0.33 }),
    frame(4, { lab: 0.06 }), // not lab → drop
    frame(5, { lab: 0.3 })
  ];
  const { frames: kept } = applyConstraintFilter(frames, graph);
  // The four lab frames survive; the two clearly-not-lab frames are dropped.
  assert.deepEqual(kept.map((f) => f.t), [0, 2, 3, 5]);
  // It must NOT collapse to a single clip.
  assert.ok(kept.length > 1, "should keep all weak-but-clear lab frames");
});

// ---------------------------------------------------------------------
// Coverage-aware relaxation: a duration target admits the next-best
// on-constraint frames so the reel can approach the requested length,
// without ever dropping below the noise floor or adding off-constraint footage.
// ---------------------------------------------------------------------
test("coverage relaxation admits more on-constraint frames toward the target", () => {
  const { graph } = buildConstraintGraph({
    scenarios: [{ id: "lab", prompt: "lab" }],
    exclusiveOnly: true,
    targetSeconds: 10,
    userSpecifiedDuration: true
  });
  const scores = [0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3, 0.28, 0.26, 0.24, 0.22, 0.2];
  const frames = scores.map((s, i) => frame(i, { lab: s }));

  // Without a target → strict adaptive cutoff keeps only the clear top cluster.
  const strict = applyConstraintFilter(frames, graph).frames;
  // With a 10s target at 1s/frame → relaxes downward to cover ~80% of target.
  const relaxed = applyConstraintFilter(frames, graph, {
    targetSeconds: 10,
    sampleEverySeconds: 1
  }).frames;

  assert.ok(relaxed.length > strict.length, "target should admit more frames");
  assert.ok(relaxed.length >= 8, `expected ~8 frames for a 10s target, got ${relaxed.length}`);
});

test("relaxation never admits frames below the noise floor", () => {
  const { graph } = buildConstraintGraph({
    scenarios: [{ id: "lab", prompt: "lab" }],
    exclusiveOnly: true,
    targetSeconds: 60,
    userSpecifiedDuration: true
  });
  const frames = [
    frame(0, { lab: 0.5 }),
    frame(1, { lab: 0.4 }),
    frame(2, { lab: 0.3 }),
    frame(3, { lab: 0.04 }) // below noise floor → never admitted even when relaxing hard
  ];
  const { frames: kept } = applyConstraintFilter(frames, graph, {
    targetSeconds: 60,
    sampleEverySeconds: 1
  });
  assert.ok(!kept.some((f) => f.t === 3), "noise-floor frame must stay excluded");
  assert.deepEqual(kept.map((f) => f.t), [0, 1, 2]);
});

// ---------------------------------------------------------------------
// Soft / no-constraint graphs pass through untouched
// ---------------------------------------------------------------------
test("soft-only graph passes all frames through (hardApplied false)", () => {
  const { graph } = buildConstraintGraph({
    scenarios: [{ id: "cooking", prompt: "cooking" }],
    exclusiveOnly: false
  });
  const frames = [frame(0, { cooking: 0.1 }), frame(1, { cooking: 0.9 })];
  const { frames: kept, report } = applyConstraintFilter(frames, graph);
  assert.equal(kept.length, 2);
  assert.equal(report.hardApplied, false);
});

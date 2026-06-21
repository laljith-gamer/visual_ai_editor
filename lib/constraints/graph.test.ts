// =====================================================================
// Tests for the constraint-graph builder + helpers (lib/constraints/graph.ts).
//
// Run via the agentic-layer runner (Node --test + --experimental-strip-types
// + the ts-ext hook, since graph.ts value-imports ../config).
// =====================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildConstraintGraph,
  isConstraintDriven,
  hasHardInclude,
  hasExclude,
  normalizeConstraintGraph
} from "./graph.ts";

// ---------------------------------------------------------------------
// "only X" → a HARD include constraint (the core acceptance behaviour)
// ---------------------------------------------------------------------
test("'only lab scenes' → one HARD include, constraint-driven, not highlight", () => {
  const { graph, excludeScenarios } = buildConstraintGraph({
    scenarios: [{ id: "lab", prompt: "laboratory interior with equipment" }],
    exclusiveOnly: true
  });
  assert.equal(graph.include.length, 1);
  assert.equal(graph.include[0].priority, "hard");
  assert.deepEqual(graph.include[0].scenarioIds, ["lab"]);
  assert.equal(graph.exclude.length, 0);
  assert.equal(graph.highlightMode, false);
  assert.equal(hasHardInclude(graph), true);
  assert.equal(isConstraintDriven(graph), true);
  assert.equal(excludeScenarios.length, 0);
});

test("'only driving segments' → HARD include for driving", () => {
  const { graph } = buildConstraintGraph({
    scenarios: [{ id: "driving", prompt: "view from a moving car / driving on a road" }],
    exclusiveOnly: true
  });
  assert.equal(graph.include[0].priority, "hard");
  assert.equal(isConstraintDriven(graph), true);
  assert.equal(graph.highlightMode, false);
});

test("'only talking-head moments' → HARD include for talking head", () => {
  const { graph } = buildConstraintGraph({
    scenarios: [{ id: "talk", prompt: "person talking directly to camera, head and shoulders" }],
    exclusiveOnly: true
  });
  assert.equal(graph.include[0].priority, "hard");
  assert.equal(isConstraintDriven(graph), true);
});

// ---------------------------------------------------------------------
// Non-exclusive → SOFT include (not constraint-driven, legacy behaviour)
// ---------------------------------------------------------------------
test("non-exclusive subject → SOFT include, NOT constraint-driven", () => {
  const { graph } = buildConstraintGraph({
    scenarios: [{ id: "cooking", prompt: "cooking moments" }],
    exclusiveOnly: false
  });
  assert.equal(graph.include[0].priority, "soft");
  assert.equal(hasHardInclude(graph), false);
  assert.equal(isConstraintDriven(graph), false);
});

// ---------------------------------------------------------------------
// Excludes → hard exclude + a weight-0 SigLIP scenario (semantic, not keyword)
// ---------------------------------------------------------------------
test("exclude subject → hard exclude constraint + weight-0 scenario", () => {
  const { graph, excludeScenarios } = buildConstraintGraph({
    scenarios: [{ id: "cooking", prompt: "cooking moments" }],
    exclusiveOnly: false,
    excludeSubjects: ["intro"]
  });
  assert.equal(graph.exclude.length, 1);
  assert.equal(graph.exclude[0].priority, "hard");
  assert.equal(hasExclude(graph), true);
  // An exclude makes the edit constraint-driven even with a soft include.
  assert.equal(isConstraintDriven(graph), true);
  // The exclude is SigLIP-scored via a weight-0 scenario, never keyword-matched.
  assert.equal(excludeScenarios.length, 1);
  assert.equal(excludeScenarios[0].weight, 0);
  assert.equal(excludeScenarios[0].prompt, "intro");
  assert.deepEqual(graph.exclude[0].scenarioIds, [excludeScenarios[0].id]);
});

test("duplicate / empty exclude subjects are deduped + dropped", () => {
  const { graph, excludeScenarios } = buildConstraintGraph({
    scenarios: [{ id: "c", prompt: "cooking" }],
    exclusiveOnly: false,
    excludeSubjects: ["intro", "Intro", " ", "x"]
  });
  // "intro"/"Intro" dedupe to one; " " dropped; "x" (<2 chars) dropped.
  assert.equal(graph.exclude.length, 1);
  assert.equal(excludeScenarios.length, 1);
});

// ---------------------------------------------------------------------
// Generic best-parts → highlightMode true, NOT constraint-driven
// ---------------------------------------------------------------------
test("genericBestParts → highlightMode true, not constraint-driven", () => {
  const { graph } = buildConstraintGraph({
    scenarios: [],
    exclusiveOnly: false,
    genericBestParts: true,
    highlightRequested: true
  });
  assert.equal(graph.highlightMode, true);
  assert.equal(isConstraintDriven(graph), false);
});

// ---------------------------------------------------------------------
// Duration target
// ---------------------------------------------------------------------
test("duration target flows onto the graph", () => {
  const { graph } = buildConstraintGraph({
    scenarios: [{ id: "lab", prompt: "lab" }],
    exclusiveOnly: true,
    targetSeconds: 120,
    userSpecifiedDuration: true
  });
  assert.equal(graph.durationSeconds, 120);
  assert.equal(graph.userSpecifiedDuration, true);
});

// ---------------------------------------------------------------------
// normalizeConstraintGraph — sanitising LLM-emitted graphs
// ---------------------------------------------------------------------
test("normalizeConstraintGraph drops dangling scenarioIds", () => {
  const g = normalizeConstraintGraph(
    {
      goal: "create short video",
      include: [
        { id: "lab", description: "lab", priority: "hard", scenarioIds: ["lab", "ghost"] }
      ],
      exclude: [],
      highlightMode: false
    },
    ["lab"] // only "lab" is a known scenario id
  );
  assert.ok(g);
  assert.deepEqual(g!.include[0].scenarioIds, ["lab"]);
  assert.equal(hasHardInclude(g), true);
});

test("normalizeConstraintGraph forces exclude priority to hard", () => {
  const g = normalizeConstraintGraph(
    {
      include: [],
      exclude: [{ id: "intro", description: "intro card", priority: "soft", scenarioIds: ["intro"] }],
      highlightMode: false
    },
    ["intro"]
  );
  assert.ok(g);
  assert.equal(g!.exclude[0].priority, "hard");
  assert.equal(isConstraintDriven(g), true);
});

test("normalizeConstraintGraph returns null for an empty / useless graph", () => {
  assert.equal(normalizeConstraintGraph({ include: [], exclude: [] }, []), null);
  assert.equal(normalizeConstraintGraph(null, []), null);
  assert.equal(normalizeConstraintGraph("nope", []), null);
});

// helper-on-undefined safety
test("predicates are safe on undefined/null graphs", () => {
  assert.equal(hasHardInclude(undefined), false);
  assert.equal(hasExclude(null), false);
  assert.equal(isConstraintDriven(undefined), false);
});

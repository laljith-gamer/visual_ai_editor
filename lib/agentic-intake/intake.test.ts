// End-to-end tests for the agentic intake router (planIntake) + the
// prompt compiler + route decision. Run via the agentic-layer test runner.

import { test } from "node:test";
import assert from "node:assert/strict";

import { planIntake, type IntakeContext } from "./intake.ts";
import { decideRoute } from "./routeDecision.ts";
import { inferBrief } from "./inferBrief.ts";
import { compileBriefPrompt, briefSummaryMessage } from "./promptCompiler.ts";

const cloud = (over: Partial<IntakeContext> = {}): IntakeContext => ({
  libraryCount: 1,
  selectedCount: 1,
  timelineClipCount: 0,
  hasActiveSource: true,
  cloudAvailable: true,
  localPlannerAvailable: false,
  cloudVisionAvailable: true,
  ...over
});

// ---------------------------------------------------------------------
// Vague → clarify (one question at a time)
// ---------------------------------------------------------------------
test("planIntake: vague 'make this cool' → clarify output type", () => {
  const out = planIntake("make this cool", cloud());
  assert.equal(out.kind, "clarify");
  if (out.kind === "clarify") {
    assert.equal(out.question.id, "intake-output-type");
    assert.equal(out.message, "What should I make?");
  }
});

// ---------------------------------------------------------------------
// Complete single-shot request → proceed with a compiled prompt
// ---------------------------------------------------------------------
test("planIntake: complete request → proceed + compiled prompt", () => {
  const out = planIntake("current video only, dark trailer, 35 sec continuous", cloud());
  assert.equal(out.kind, "proceed");
  if (out.kind === "proceed") {
    assert.ok(out.compiledPrompt.includes("vertical 9:16") || out.compiledPrompt.includes("9:16"));
    assert.ok(out.compiledPrompt.includes("35 seconds"));
    assert.ok(out.compiledPrompt.toLowerCase().includes("continuous"));
    assert.ok(out.summary.startsWith("Got it"));
  }
});

// ---------------------------------------------------------------------
// Multi-turn brief building: vague → answer → proceed
// ---------------------------------------------------------------------
test("planIntake: builds an EditBrief across turns", () => {
  const first = planIntake("make this cool", cloud());
  assert.equal(first.kind, "clarify");
  const prior = first.brief;
  // User taps the "Best-moments reel" chip.
  const second = planIntake("Best-moments reel", cloud(), prior);
  assert.equal(second.kind, "proceed");
  if (second.kind === "proceed") {
    assert.ok(second.brief.output.outputType === "multi_clip");
    // The earlier turn's scope (current, single video) is preserved.
    assert.equal(second.brief.sourceScope.type, "current");
  }
});

// ---------------------------------------------------------------------
// Continuous single-video request does NOT ask for another clip
// ---------------------------------------------------------------------
test("planIntake: continuous single-video request never asks for another clip", () => {
  const out = planIntake("use current video only as one continuous clip, 20s", cloud());
  assert.equal(out.kind, "proceed");
  if (out.kind === "proceed") {
    assert.equal(out.brief.constraints.doNotAskForAnotherClip, true);
    assert.ok(out.compiledPrompt.toLowerCase().includes("do not ask for another clip"));
    assert.ok(out.compiledPrompt.toLowerCase().includes("continuous"));
  }
});

// ---------------------------------------------------------------------
// describe → vision/briefing route, NOT local planner
// ---------------------------------------------------------------------
test("planIntake: 'describe this video' routes to vision/briefing (passthrough)", () => {
  const out = planIntake("describe this video and tell me the best parts", cloud());
  assert.equal(out.kind, "passthrough");
  assert.equal(out.route.target, "vision_briefing");
  assert.notEqual(out.route.target, "local_planner");
});

test("decideRoute: describe with no cloud vision → honest manual_fallback", () => {
  const brief = inferBrief("what's in this video", { libraryCount: 1, selectedCount: 1, timelineClipCount: 0, hasActiveSource: true });
  const route = decideRoute(brief, {
    cloudAvailable: false,
    localPlannerAvailable: true,
    cloudVisionAvailable: false,
    willAsk: false
  });
  assert.equal(route.target, "manual_fallback");
});

// ---------------------------------------------------------------------
// render → fast command path (intake passes through)
// ---------------------------------------------------------------------
test("planIntake: 'render' → passthrough fast_command", () => {
  const out = planIntake("render", cloud());
  assert.equal(out.kind, "passthrough");
  assert.equal(out.route.target, "fast_command");
});

// ---------------------------------------------------------------------
// Cloud disabled → local planner; nothing available → manual fallback
// ---------------------------------------------------------------------
test("decideRoute: cloud off + local on → local_planner", () => {
  const brief = inferBrief("make a 30s reel of cooking", { libraryCount: 1, selectedCount: 1, timelineClipCount: 0, hasActiveSource: true });
  const route = decideRoute(brief, {
    cloudAvailable: false,
    localPlannerAvailable: true,
    willAsk: false
  });
  assert.equal(route.target, "local_planner");
});

test("decideRoute: nothing available → manual_fallback", () => {
  const brief = inferBrief("make a 30s reel of cooking", { libraryCount: 1, selectedCount: 1, timelineClipCount: 0, hasActiveSource: true });
  const route = decideRoute(brief, {
    cloudAvailable: false,
    localPlannerAvailable: false,
    willAsk: false
  });
  assert.equal(route.target, "manual_fallback");
});

// ---------------------------------------------------------------------
// Compiled prompt excludes the messy raw text
// ---------------------------------------------------------------------
test("compiled prompt never echoes messy raw text", () => {
  const raw = "plz bro make a 30 second vertical reel of cooking";
  const brief = inferBrief(raw, { libraryCount: 1, selectedCount: 1, timelineClipCount: 0, hasActiveSource: true });
  const compiled = compileBriefPrompt(brief);
  assert.ok(!compiled.includes("plz"), compiled);
  assert.ok(!compiled.includes("bro"), compiled);
  assert.notEqual(compiled, raw);
  // …but it preserves the real intent.
  assert.ok(compiled.includes("cooking"));
  assert.ok(compiled.includes("30 seconds"));
});

// ---------------------------------------------------------------------
// Unsupported effects: requested but NOT claimed as rendered
// ---------------------------------------------------------------------
test("compiled prompt lists unsupported effects as requests, never claims them", () => {
  const brief = inferBrief(
    "make a 30s vertical reel of cooking with slow zoom and color grade",
    { libraryCount: 1, selectedCount: 1, timelineClipCount: 0, hasActiveSource: true }
  );
  const compiled = compileBriefPrompt(brief).toLowerCase();
  assert.ok(compiled.includes("requested effects"));
  assert.ok(compiled.includes("slow zoom"));
  assert.ok(compiled.includes("not implemented yet"));
  // Human summary is also honest.
  const summary = briefSummaryMessage(brief);
  assert.ok(/not rendered yet|isn.t rendered yet|aren.t rendered yet/i.test(summary), summary);
});

// ---------------------------------------------------------------------
// 'combine these videos for reels' (multi-source) still works
// ---------------------------------------------------------------------
test("planIntake: 'combine all videos for reels' → all scope, vertical, proceed/clarify sensibly", () => {
  const out = planIntake("combine all videos for reels", cloud({ libraryCount: 3, selectedCount: 3 }));
  assert.equal(out.brief.sourceScope.type, "all");
  assert.equal(out.brief.output.format, "vertical");
});

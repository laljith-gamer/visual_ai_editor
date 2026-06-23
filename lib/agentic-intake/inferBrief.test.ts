// Tests for the agentic-intake EditBrief inference + question engine +
// capability matrix. Run via the agentic-layer test runner
// (node --test --experimental-strip-types + ts-ext hook, since these
// modules value-import ../config through the interpreter).

import { test } from "node:test";
import assert from "node:assert/strict";

import { inferBrief, type InferContext } from "./inferBrief.ts";
import { decideQuestion } from "./questionEngine.ts";
import { classifyEffects } from "./capabilityMatrix.ts";

const oneVideo: InferContext = {
  libraryCount: 1,
  selectedCount: 1,
  timelineClipCount: 0,
  hasActiveSource: true
};
const manyVideos: InferContext = {
  libraryCount: 3,
  selectedCount: 3,
  timelineClipCount: 0,
  hasActiveSource: true
};

// ---------------------------------------------------------------------
// Acceptance: vague prompt → asks output type
// ---------------------------------------------------------------------
test("vague 'make this cool' → asks output type", () => {
  const brief = inferBrief("make this cool", oneVideo);
  assert.ok(brief.missing.includes("output_type"), JSON.stringify(brief.missing));
  const q = decideQuestion(brief);
  assert.equal(q.shouldAsk, true);
  assert.equal(q.field, "output_type");
  assert.equal(q.question?.id, "intake-output-type");
  assert.ok((q.question?.suggestions.length ?? 0) >= 2);
});

// ---------------------------------------------------------------------
// Acceptance: "30 sec YouTube short" → infers duration + vertical
// ---------------------------------------------------------------------
test("'make a 30 sec youtube short' infers duration + vertical + platform", () => {
  const brief = inferBrief("make a 30 sec youtube short", oneVideo);
  assert.equal(brief.output.durationSeconds, 30);
  assert.equal(brief.output.format, "vertical");
  assert.equal(brief.output.platform, "youtube_shorts");
  // Structure is known (deliverable noun "short"); the open question is focus.
  assert.ok(!brief.missing.includes("output_type"));
  const q = decideQuestion(brief);
  assert.equal(q.field, "content_focus");
});

// ---------------------------------------------------------------------
// Acceptance: source scope inference
// ---------------------------------------------------------------------
test("'current video only' → sourceScope current", () => {
  const brief = inferBrief("current video only, dark trailer, 35 sec", manyVideos);
  assert.equal(brief.sourceScope.type, "current");
});

test("one video uploaded → defaults to current source", () => {
  const brief = inferBrief("make a reel", oneVideo);
  assert.equal(brief.sourceScope.type, "current");
  assert.ok(!brief.missing.includes("source_scope"));
});

test("'all uploaded videos' → sourceScope all", () => {
  const brief = inferBrief("combine all uploaded videos for reels", manyVideos);
  assert.equal(brief.sourceScope.type, "all");
});

test("multiple videos + no scope → source_scope is asked", () => {
  const brief = inferBrief("make a 30s reel of the best parts", manyVideos);
  assert.equal(brief.sourceScope.type, "unknown");
  assert.ok(brief.missing.includes("source_scope"));
  assert.equal(decideQuestion(brief).field, "source_scope");
});

// ---------------------------------------------------------------------
// Acceptance: output type inference
// ---------------------------------------------------------------------
test("'one continuous short' → outputType single_continuous", () => {
  const brief = inferBrief("make one continuous short", oneVideo);
  assert.equal(brief.output.outputType, "single_continuous");
  assert.equal(brief.constraints.userSaidContinuous, true);
});

test("'best moments' → highlight reel, multi_clip, generic best parts", () => {
  const brief = inferBrief("make a reel of the best moments", oneVideo);
  assert.equal(brief.intentKind, "highlight_reel");
  assert.equal(brief.output.outputType, "multi_clip");
  assert.equal(brief.content.genericBestParts, true);
});

// ---------------------------------------------------------------------
// Acceptance: quoted / listed text lines → textOverlays
// ---------------------------------------------------------------------
test("'add these texts: one, two, three' → 3 text overlays, not re-asked", () => {
  const brief = inferBrief("add these texts: one, two, three", oneVideo);
  const overlays = brief.effects.textOverlays ?? [];
  assert.equal(overlays.length, 3);
  assert.deepEqual(overlays.map((o) => o.text), ["one", "two", "three"]);
  assert.ok(brief.effects.requestedVisualEffects?.includes("text_overlay"));
});

test("quoted lines become text overlays", () => {
  const brief = inferBrief(
    'make a reel of cooking with text "The fire was never just power", "It was rage"',
    oneVideo
  );
  const overlays = brief.effects.textOverlays ?? [];
  assert.equal(overlays.length, 2);
  assert.equal(overlays[0].text, "The fire was never just power");
});

// ---------------------------------------------------------------------
// Acceptance: 'describe this video' is NOT a creation intent
// ---------------------------------------------------------------------
test("'describe this video' → describe_video intent (handled by vision path)", () => {
  const brief = inferBrief("describe this video and tell me what happens", oneVideo);
  assert.equal(brief.intentKind, "describe_video");
  assert.deepEqual(brief.missing, []); // no creation questions
});

// ---------------------------------------------------------------------
// Acceptance: 'render' is a fast control command
// ---------------------------------------------------------------------
test("'render' → export_render intent (fast command path)", () => {
  const brief = inferBrief("render", oneVideo);
  assert.equal(brief.intentKind, "export_render");
});

// ---------------------------------------------------------------------
// Acceptance: unsupported effect captured but classified unsupported
// ---------------------------------------------------------------------
test("requested unsupported effects are captured + classified honestly", () => {
  const brief = inferBrief(
    "make a 30s vertical reel of cooking with slow zoom and color grade",
    oneVideo
  );
  const vfx = brief.effects.requestedVisualEffects ?? [];
  assert.ok(vfx.includes("slow_zoom"));
  assert.ok(vfx.includes("color_grade"));
  const split = classifyEffects(vfx, brief.effects.requestedAudioEffects ?? []);
  assert.ok(split.unsupported.includes("slow_zoom"));
  assert.ok(split.unsupported.includes("color_grade"));
  assert.equal(split.supported.length, 0);
});

// ---------------------------------------------------------------------
// No genre hardcoding — any subject word is treated the same way
// ---------------------------------------------------------------------
test("subject words across categories are treated uniformly (no genre table)", () => {
  for (const subject of ["gaming", "wedding", "cooking", "podcast", "skydiving"]) {
    const brief = inferBrief(`make a 20s reel of the ${subject}`, oneVideo);
    assert.equal(brief.content.focus, subject, `${subject} should be the focus`);
    assert.equal(brief.output.durationSeconds, 20);
    assert.deepEqual(brief.missing, [], `${subject} should be complete`);
  }
});

// ---------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------
test("'but avoid intro' is captured as an avoid, not a focus", () => {
  const brief = inferBrief(
    "make a 30s reel of cooking but avoid the intro",
    oneVideo
  );
  assert.ok((brief.content.avoid ?? []).includes("intro"));
  assert.equal(brief.content.focus, "cooking");
});


// ---------------------------------------------------------------------
// Multi-video "both / all" → all scope on the FIRST turn, so intake never
// asks "Which video should I use?" for a request that already said "both".
// ---------------------------------------------------------------------
const twoVideos: InferContext = {
  libraryCount: 2,
  selectedCount: 2,
  timelineClipCount: 0,
  hasActiveSource: true
};

test("'combine best moments in both videos, 10 min' → all scope, does not ask source", () => {
  const brief = inferBrief("combine best moments in both video and make a 10 min shorts", twoVideos);
  assert.equal(brief.sourceScope.type, "all", JSON.stringify(brief.sourceScope));
  assert.ok(!brief.missing.includes("source_scope"), JSON.stringify(brief.missing));
});

test("'use all videos for a highlights reel' → all scope (multi-video)", () => {
  const brief = inferBrief("use all videos for a highlights reel", manyVideos);
  assert.equal(brief.sourceScope.type, "all");
  assert.ok(!brief.missing.includes("source_scope"));
});

test("'this video only' still resolves to current scope (multi-video)", () => {
  const brief = inferBrief("make a reel from this video only", manyVideos);
  assert.equal(brief.sourceScope.type, "current");
});

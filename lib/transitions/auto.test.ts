import { test } from "node:test";
import assert from "node:assert/strict";
import { selectAutoTransition } from "./auto.ts";
import type { TransitionClip } from "./features.ts";

const clip = (over: Partial<TransitionClip> & { id: string }): TransitionClip => ({
  start: 0,
  end: 5,
  ...over
});

test("same source + adjacent → cut", () => {
  const t = selectAutoTransition(
    clip({ id: "a", sourceId: "v1", start: 0, end: 5 }),
    clip({ id: "b", sourceId: "v1", start: 5.2, end: 9 })
  );
  assert.equal(t.type, "cut");
  assert.equal(t.render, "none");
  assert.equal(t.mode, "auto");
  assert.ok((t.evidence ?? []).length > 0);
});

test("high motion → cut", () => {
  const t = selectAutoTransition(
    clip({ id: "a", sourceId: "v1", motion: 0.7 }),
    clip({ id: "b", sourceId: "v2", motion: 0.2 })
  );
  assert.equal(t.type, "cut");
  assert.match(t.reason ?? "", /motion/i);
});

test("low motion, different source → crossfade", () => {
  const t = selectAutoTransition(
    clip({ id: "a", sourceId: "v1", motion: 0.1 }),
    clip({ id: "b", sourceId: "v2", motion: 0.15 })
  );
  assert.equal(t.type, "crossfade");
  assert.equal(t.render, "crossfade");
});

test("strong contrast (saliency) → fade", () => {
  const t = selectAutoTransition(
    clip({ id: "a", sourceId: "v1", saliency: 0.1 }),
    clip({ id: "b", sourceId: "v2", saliency: 0.8 })
  );
  assert.equal(t.type, "fade");
  assert.equal(t.render, "fade");
});

test("topic change across sources → fade", () => {
  const t = selectAutoTransition(
    clip({ id: "a", sourceId: "v1", label: "cooking pasta" }),
    clip({ id: "b", sourceId: "v2", label: "skydiving jump" }),
    { getTranscriptText: (c) => (c.id === "a" ? "boil the pasta" : "jump from the plane") }
  );
  assert.equal(t.type, "fade");
});

test("related content across sources → crossfade", () => {
  const t = selectAutoTransition(
    clip({ id: "a", sourceId: "v1", label: "dragon fight scene" }),
    clip({ id: "b", sourceId: "v2", label: "dragon fight roar" })
  );
  assert.equal(t.type, "crossfade");
});

test("user smooth preference biases away from cut → crossfade", () => {
  // Same source + adjacent would normally be a cut; smooth flips it.
  const t = selectAutoTransition(
    clip({ id: "a", sourceId: "v1", start: 0, end: 5 }),
    clip({ id: "b", sourceId: "v1", start: 5.2, end: 9 }),
    { userPreferredSmooth: true }
  );
  assert.equal(t.type, "crossfade");
});

test("user fast preference biases toward cut", () => {
  // Low-motion different source would normally crossfade; fast flips it.
  const t = selectAutoTransition(
    clip({ id: "a", sourceId: "v1", motion: 0.1 }),
    clip({ id: "b", sourceId: "v2", motion: 0.1 }),
    { userPreferredFastCuts: true }
  );
  assert.equal(t.type, "cut");
});

test("carries duration default + index", () => {
  const t = selectAutoTransition(clip({ id: "a", sourceId: "v1" }), clip({ id: "b", sourceId: "v1", start: 5.2, end: 9 }), {}, { index: 2 });
  assert.equal(t.index, 2);
  assert.equal(t.durationSeconds, 0.4);
});

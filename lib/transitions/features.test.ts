import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTransitionFeatures, type TransitionClip } from "./features.ts";

const clip = (over: Partial<TransitionClip> & { id: string }): TransitionClip => ({
  start: 0,
  end: 5,
  ...over
});

test("same source adjacent clip → sameSource + temporallyAdjacent", () => {
  const f = buildTransitionFeatures(
    clip({ id: "a", sourceId: "v1", start: 0, end: 5 }),
    clip({ id: "b", sourceId: "v1", start: 5.2, end: 9 })
  );
  assert.equal(f.sameSource, true);
  assert.equal(f.sourceChanged, false);
  assert.equal(f.timeGapSeconds, 0.2);
  assert.equal(f.temporallyAdjacent, true);
});

test("different source clips → sourceChanged, null time gap", () => {
  const f = buildTransitionFeatures(
    clip({ id: "a", sourceId: "v1" }),
    clip({ id: "b", sourceId: "v2" })
  );
  assert.equal(f.sourceChanged, true);
  assert.equal(f.timeGapSeconds, null);
  assert.equal(f.temporallyAdjacent, false);
});

test("missing transcript/tree/motion does not crash and yields nulls", () => {
  const f = buildTransitionFeatures(clip({ id: "a" }), clip({ id: "b" }));
  assert.equal(f.transcriptOverlap, null);
  assert.equal(f.sameScene, null);
  assert.equal(f.prevMotion, null);
  assert.equal(f.motionContrast, null);
  assert.ok(Array.isArray(f.evidence));
});

test("a throwing resolver never breaks extraction", () => {
  const f = buildTransitionFeatures(clip({ id: "a" }), clip({ id: "b" }), {
    getMotion: () => {
      throw new Error("boom");
    },
    getTranscriptText: () => {
      throw new Error("boom");
    }
  });
  assert.equal(f.prevMotion, null);
  assert.equal(f.transcriptOverlap, null);
});

test("transcript + tag overlap computed when data exists", () => {
  const f = buildTransitionFeatures(
    clip({ id: "a", label: "dragon fight scene" }),
    clip({ id: "b", label: "dragon roar" }),
    {
      getTranscriptText: (c) =>
        c.id === "a" ? "the dragon breathes fire" : "dragon fire everywhere"
    }
  );
  assert.ok(f.tagOverlap !== null && f.tagOverlap > 0, "tag overlap > 0");
  assert.ok(f.transcriptOverlap !== null && f.transcriptOverlap > 0, "transcript overlap > 0");
});

test("motion/saliency contrast computed from both sides", () => {
  const f = buildTransitionFeatures(
    clip({ id: "a", motion: 0.1, saliency: 0.2 }),
    clip({ id: "b", motion: 0.8, saliency: 0.7 })
  );
  assert.equal(f.motionContrast, 0.7);
  assert.equal(f.saliencyContrast, 0.5);
});

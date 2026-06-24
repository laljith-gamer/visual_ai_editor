import { test } from "node:test";
import assert from "node:assert/strict";

import {
  composite,
  motionOnlyScores,
  isCloudResultUsable
} from "./scoreFallback.ts";
import type { FrameScore, SignalWeights } from "@/lib/types";
import type { SampledFrame } from "@/lib/pipeline/sample";

const W: SignalWeights = { semantic: 0.6, motion: 0.25, saliency: 0.15 };

function frame(over: Partial<SampledFrame>): SampledFrame {
  return {
    t: 0,
    motion: 0,
    saliency: 0,
    focusX: 0.5,
    focusY: 0.5,
    blob: new Blob(),
    ...over
  } as SampledFrame;
}

test("composite is a clamped weighted sum of the three signals", () => {
  assert.equal(composite(0, 0, 0, W), 0);
  assert.equal(composite(1, 1, 1, W), 1);
  // semantic only, weight 0.6
  assert.ok(Math.abs(composite(1, 0, 0, W) - 0.6) < 1e-9);
  // over-unity inputs clamp to 1
  assert.equal(composite(5, 5, 5, W), 1);
});

test("motionOnlyScores: semantic = 0, score from motion+saliency, fields preserved", () => {
  const frames = [
    frame({ t: 1, motion: 0.8, saliency: 0.4, focusX: 0.3, focusY: 0.7 }),
    frame({ t: 2, motion: 0.2, saliency: 0.1 })
  ];
  const out = motionOnlyScores(frames, W);
  assert.equal(out.length, 2);
  assert.equal(out[0].semantic, 0);
  assert.deepEqual(out[0].labels, {});
  assert.equal(out[0].t, 1);
  assert.equal(out[0].focusX, 0.3);
  // score = 0.25*0.8 + 0.15*0.4 = 0.26
  assert.ok(Math.abs(out[0].score - 0.26) < 1e-9);
  // higher-motion frame ranks above the quiet one
  assert.ok(out[0].score > out[1].score);
});

test("isCloudResultUsable: true when any frame has real labels", () => {
  const usable: FrameScore[] = [
    { t: 0, labels: {}, semantic: 0, motion: 0, saliency: 0, score: 0 },
    { t: 1, labels: { combat: 0.7 }, semantic: 0.7, motion: 0, saliency: 0, score: 0.7 }
  ];
  assert.equal(isCloudResultUsable(usable), true);
});

test("isCloudResultUsable: false when every frame is empty (cloud unconfigured/503)", () => {
  const empty: FrameScore[] = [
    { t: 0, labels: {}, semantic: 0, motion: 0.3, saliency: 0.2, score: 0.1 },
    { t: 1, labels: {}, semantic: 0, motion: 0.1, saliency: 0.1, score: 0.05 }
  ];
  // This is exactly the signal the orchestrator uses to fall back from cloud
  // to on-device scoring instead of dropping to the motion guess.
  assert.equal(isCloudResultUsable(empty), false);
});

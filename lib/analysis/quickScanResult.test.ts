// Tests for the pure quick-scan reducer (motion/saliency → compact memory).

import { test } from "node:test";
import assert from "node:assert/strict";

import { summarizeQuickScan, type QuickScanFrame } from "./quickScanResult.ts";

function frames(spec: Array<[number, number, number]>): QuickScanFrame[] {
  return spec.map(([t, motion, saliency]) => ({ t, motion, saliency }));
}

test("level is always 1 (a quick structural scan)", () => {
  const r = summarizeQuickScan(frames([[0, 0.1, 0.2]]), 10);
  assert.equal(r.patch.level, 1);
});

test("high-motion frames become motion peaks + candidate windows", () => {
  const r = summarizeQuickScan(
    frames([
      [0, 0.05, 0.2],
      [2, 0.8, 0.75],
      [4, 0.85, 0.8],
      [6, 0.05, 0.2]
    ]),
    8
  );
  assert.ok((r.patch.motionPeaks?.length ?? 0) >= 2);
  assert.ok((r.patch.knownGoodWindows?.length ?? 0) >= 2);
  assert.ok(r.candidateStrength >= 0.5);
  assert.equal(r.lowConfidence, false);
});

test("windows are non-zero length (sized by the sampling step)", () => {
  const r = summarizeQuickScan(
    frames([
      [0, 0.9, 0.9],
      [3, 0.9, 0.9]
    ]),
    6
  );
  for (const w of r.patch.knownGoodWindows ?? []) {
    assert.ok(w.end > w.start, `window ${JSON.stringify(w)} should be non-zero`);
  }
});

test("flat / static footage → low confidence + static ranges", () => {
  const r = summarizeQuickScan(
    frames([
      [0, 0.02, 0.1],
      [2, 0.03, 0.12],
      [4, 0.01, 0.09],
      [6, 0.02, 0.11]
    ]),
    8
  );
  assert.equal(r.lowConfidence, true);
  assert.ok((r.patch.staticRanges?.length ?? 0) >= 2);
  assert.ok(r.confidence < 0.35);
});

test("keyframes are capped + carry NO image data (t/motion/saliency only)", () => {
  const many: QuickScanFrame[] = [];
  for (let i = 0; i < 60; i++) many.push({ t: i, motion: 0.3, saliency: 0.4 });
  const r = summarizeQuickScan(many, 60);
  assert.ok((r.patch.keyframes?.length ?? 0) <= 16);
  for (const k of r.patch.keyframes ?? []) {
    assert.deepEqual(Object.keys(k).sort(), ["motion", "saliency", "t"]);
  }
});

test("mixed footage reports both motion and static content types", () => {
  const r = summarizeQuickScan(
    frames([
      [0, 0.85, 0.8],
      [2, 0.02, 0.1],
      [4, 0.8, 0.75],
      [6, 0.01, 0.09],
      [8, 0.02, 0.1]
    ]),
    10
  );
  assert.ok(r.contentTypes.includes("motion"));
  assert.ok(r.contentTypes.includes("static"));
});

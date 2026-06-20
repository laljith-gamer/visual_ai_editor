import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveClipDurationBounds, clipLengthForScore } from "./clipDuration.ts";

test("short video → min ~1s, modest max", () => {
  const b = deriveClipDurationBounds({ videoDuration: 30 });
  assert.ok(b.minClipSeconds >= 1 && b.minClipSeconds <= 1.5, `min=${b.minClipSeconds}`);
  assert.ok(b.maxClipSeconds >= 4 && b.maxClipSeconds <= 6, `max=${b.maxClipSeconds}`);
  assert.ok(b.minClipSeconds < b.maxClipSeconds);
});

test("long video → larger max (scales with the video)", () => {
  const short = deriveClipDurationBounds({ videoDuration: 30 });
  const long = deriveClipDurationBounds({ videoDuration: 1200 });
  assert.ok(long.maxClipSeconds > short.maxClipSeconds, "long video allows longer clips");
  assert.ok(long.maxClipSeconds <= 30, "but never beyond the absolute ceiling");
});

test("min can be as low as 1s (not a fixed 3)", () => {
  const b = deriveClipDurationBounds({ videoDuration: 12 });
  assert.equal(b.minClipSeconds, 1);
});

test("explicit user bounds win (clamped to absolutes)", () => {
  const b = deriveClipDurationBounds({
    videoDuration: 600,
    userMinClipSeconds: 2,
    userMaxClipSeconds: 10
  });
  assert.equal(b.minClipSeconds, 2);
  assert.equal(b.maxClipSeconds, 10);
});

test("target duration shapes preferred clip length", () => {
  const b = deriveClipDurationBounds({ videoDuration: 600, targetSeconds: 60 });
  // ~60/6 = 10, clamped into [min,max]
  assert.ok(b.preferredClipSeconds >= b.minClipSeconds && b.preferredClipSeconds <= b.maxClipSeconds);
});

test("max never exceeds the video length", () => {
  const b = deriveClipDurationBounds({ videoDuration: 3 });
  assert.ok(b.maxClipSeconds <= 3.001);
});

test("clipLengthForScore is monotonic: stronger score → longer clip", () => {
  const bounds = { minClipSeconds: 1, maxClipSeconds: 8, preferredClipSeconds: 4 };
  const low = clipLengthForScore(0.05, bounds);
  const mid = clipLengthForScore(0.5, bounds);
  const high = clipLengthForScore(0.95, bounds);
  assert.ok(low < mid, `low ${low} < mid ${mid}`);
  assert.ok(mid < high, `mid ${mid} < high ${high}`);
  assert.ok(low >= 1 && high <= 8);
});

test("clipLengthForScore stays within bounds at extremes", () => {
  const bounds = { minClipSeconds: 1, maxClipSeconds: 8, preferredClipSeconds: 4 };
  assert.ok(clipLengthForScore(0, bounds) >= 1);
  assert.ok(clipLengthForScore(1, bounds) <= 8);
});

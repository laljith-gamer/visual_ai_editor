// Tests for the CPU/offline best-parts fallback (issue #62).
//
// Run with Node's built-in runner + --experimental-strip-types. The module
// under test only imports config constants (relative path), so it loads
// without the @/ alias resolver.

import { test } from "node:test";
import assert from "node:assert/strict";
import { expandClipRange, buildOfflineBestParts } from "./bestParts.ts";

test("expandClipRange grows a 1s peak to the useful minimum, centered", () => {
  const out = expandClipRange(
    { start: 100, end: 101 },
    { sourceDuration: 1169, minSeconds: 6, maxSeconds: 8, occupied: [] }
  );
  const dur = out.end - out.start;
  assert.ok(dur >= 5.99 && dur <= 8.01, `expected ~6-8s, got ${dur}`);
  // Centered on the original peak (100.5).
  const center = (out.start + out.end) / 2;
  assert.ok(Math.abs(center - 100.5) < 0.5, `center drifted: ${center}`);
});

test("expandClipRange never leaves the source bounds", () => {
  const atStart = expandClipRange(
    { start: 0, end: 1 },
    { sourceDuration: 20, minSeconds: 6, maxSeconds: 8 }
  );
  assert.ok(atStart.start >= 0, atStart.start);
  const atEnd = expandClipRange(
    { start: 19, end: 20 },
    { sourceDuration: 20, minSeconds: 6, maxSeconds: 8 }
  );
  assert.ok(atEnd.end <= 20, atEnd.end);
  assert.ok(atEnd.end - atEnd.start >= 5.99, atEnd.end - atEnd.start);
});

test("expandClipRange shrinks to avoid overlapping an occupied clip", () => {
  // Occupied [110, 118]; a peak at 107-108 may only grow up to 110.
  const out = expandClipRange(
    { start: 107, end: 108 },
    {
      sourceDuration: 1169,
      minSeconds: 8,
      maxSeconds: 8,
      occupied: [{ start: 110, end: 118 }]
    }
  );
  assert.ok(out.end <= 110.001, `overlapped occupied clip: end=${out.end}`);
});

test("buildOfflineBestParts produces multiple spread clips approaching the target", () => {
  // 19-minute source, 1s candidate peaks spread across it.
  const sourceDuration = 1169;
  const candidates = [];
  for (let t = 30; t < sourceDuration; t += 80) {
    candidates.push({ start: t, end: t + 1, score: 0.3 + (t % 7) / 20 });
  }
  const clips = buildOfflineBestParts({
    candidates,
    sourceDuration,
    targetSeconds: 40,
    minUsefulSeconds: 6,
    maxClipSeconds: 8,
    maxClips: 12
  });
  const total = clips.reduce((a, c) => a + (c.end - c.start), 0);
  assert.ok(clips.length >= 4, `expected several clips, got ${clips.length}`);
  // Approaches 40s (within one clip-length of the target).
  assert.ok(total >= 32 && total <= 48, `total=${total}`);
  // No overlaps, ordered by start.
  for (let k = 1; k < clips.length; k++) {
    assert.ok(clips[k].start >= clips[k - 1].end, `overlap at ${k}`);
  }
  // Spread: clips are not all clustered in the first 10% of the video.
  assert.ok(
    clips[clips.length - 1].start > sourceDuration * 0.3,
    "clips not spread across the source"
  );
});

test("buildOfflineBestParts with a single 1s candidate expands it (no 1s output)", () => {
  const clips = buildOfflineBestParts({
    candidates: [{ start: 1071, end: 1072, score: 0.35 }],
    sourceDuration: 1169,
    targetSeconds: 40,
    minUsefulSeconds: 6,
    maxClipSeconds: 8,
    maxClips: 12
  });
  assert.equal(clips.length, 1);
  assert.ok(clips[0].end - clips[0].start >= 5.99, clips[0].end - clips[0].start);
});

test("buildOfflineBestParts returns nothing when there are no candidates", () => {
  const clips = buildOfflineBestParts({
    candidates: [],
    sourceDuration: 1169,
    targetSeconds: 40,
    minUsefulSeconds: 6,
    maxClipSeconds: 8,
    maxClips: 12
  });
  assert.deepEqual(clips, []);
});

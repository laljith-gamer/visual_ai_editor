import { test } from "node:test";
import assert from "node:assert/strict";

import { pickFillIndices, spansOverlap, type FillSpan } from "./selectionFill.ts";

test("spansOverlap: shared time overlaps, touching edges do not", () => {
  assert.equal(spansOverlap({ start: 0, end: 5 }, { start: 4, end: 8 }), true);
  assert.equal(spansOverlap({ start: 0, end: 5 }, { start: 5, end: 8 }), false);
  assert.equal(spansOverlap({ start: 0, end: 5 }, { start: 6, end: 8 }), false);
});

test("pickFillIndices: tops up toward the target, highest score first", () => {
  // Selection so far = 30s; target 60s. Three 10s candidates available.
  const pool: FillSpan[] = [
    { start: 30, end: 40, score: 0.2 },
    { start: 40, end: 50, score: 0.9 },
    { start: 50, end: 60, score: 0.5 }
  ];
  const add = pickFillIndices(pool, [{ start: 0, end: 30 }], 30, 60);
  // Needs 30s more → all three 10s clips, but picked in score order.
  assert.deepEqual(add, [1, 2, 0]);
});

test("pickFillIndices: stops as soon as the target is reached", () => {
  const pool: FillSpan[] = [
    { start: 0, end: 20, score: 0.9 },
    { start: 20, end: 40, score: 0.8 },
    { start: 40, end: 60, score: 0.7 }
  ];
  // Already at 30s, target 60s → only needs ~30s more → 2 clips, not 3.
  const add = pickFillIndices(pool, [], 30, 60);
  assert.equal(add.length, 2);
  assert.deepEqual(add, [0, 1]);
});

test("pickFillIndices: skips clips that overlap the current selection", () => {
  const pool: FillSpan[] = [
    { start: 5, end: 15, score: 0.9 }, // overlaps the occupied 0..10
    { start: 20, end: 30, score: 0.6 }
  ];
  const add = pickFillIndices(pool, [{ start: 0, end: 10 }], 10, 60);
  assert.deepEqual(add, [1]);
});

test("pickFillIndices: nothing to do when already at/over target", () => {
  const pool: FillSpan[] = [{ start: 0, end: 10, score: 1 }];
  assert.deepEqual(pickFillIndices(pool, [], 60, 60), []);
  assert.deepEqual(pickFillIndices(pool, [], 10, 0), []);
});

test("pickFillIndices: undershoots gracefully when the pool runs out", () => {
  const pool: FillSpan[] = [{ start: 0, end: 10, score: 1 }];
  // Want 60s but only 10s of non-overlapping material exists.
  const add = pickFillIndices(pool, [], 0, 60);
  assert.deepEqual(add, [0]);
});

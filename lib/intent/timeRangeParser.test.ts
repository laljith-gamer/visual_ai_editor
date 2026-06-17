import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTimeRangeSpec, resolveTimeRange } from "./timeRangeParser.ts";

test("first 2 min", () => {
  const spec = parseTimeRangeSpec("add first 2 min");
  assert.equal(spec?.kind, "first_amount");
  assert.equal((spec as { seconds: number }).seconds, 120);
  const r = resolveTimeRange({ spec: spec!, durationSeconds: 600 });
  assert.deepEqual([r?.start, r?.end], [0, 120]);
});

test("last 30 sec", () => {
  const spec = parseTimeRangeSpec("add last 30 sec");
  assert.equal(spec?.kind, "last_amount");
  const r = resolveTimeRange({ spec: spec!, durationSeconds: 600 });
  assert.deepEqual([r?.start, r?.end], [570, 600]);
});

test("middle 1 min", () => {
  const spec = parseTimeRangeSpec("the middle 1 min");
  assert.equal(spec?.kind, "middle_amount");
  const r = resolveTimeRange({ spec: spec!, durationSeconds: 600 });
  assert.deepEqual([r?.start, r?.end], [270, 330]);
});

test("1:20 to 2:10 (exact)", () => {
  const spec = parseTimeRangeSpec("from 1:20 to 2:10");
  assert.equal(spec?.kind, "absolute");
  const r = resolveTimeRange({ spec: spec!, durationSeconds: 600 });
  assert.deepEqual([r?.start, r?.end], [80, 130]);
  assert.equal(r?.exact, true);
});

test("0:30-0:45 dash form", () => {
  const spec = parseTimeRangeSpec("0:30-0:45");
  assert.equal(spec?.kind, "absolute");
});

test("first half", () => {
  const spec = parseTimeRangeSpec("use the first half");
  assert.equal(spec?.kind, "first_half");
  const r = resolveTimeRange({ spec: spec!, durationSeconds: 600 });
  assert.deepEqual([r?.start, r?.end], [0, 300]);
});

test("second half", () => {
  const spec = parseTimeRangeSpec("the second half");
  assert.equal(spec?.kind, "second_half");
  const r = resolveTimeRange({ spec: spec!, durationSeconds: 600 });
  assert.deepEqual([r?.start, r?.end], [300, 600]);
});

test("before 1:00 and after 2:00", () => {
  const before = parseTimeRangeSpec("before 1:00");
  assert.equal(before?.kind, "before_time");
  const after = parseTimeRangeSpec("after 2:00");
  assert.equal(after?.kind, "after_time");
});

test("10 seconds before clip 2 (relative)", () => {
  const spec = parseTimeRangeSpec("10 seconds before clip 2");
  assert.equal(spec?.kind, "relative_to_clip");
  const r = resolveTimeRange({ spec: spec!, durationSeconds: 600, anchorClip: { start: 100, end: 120 } });
  assert.deepEqual([r?.start, r?.end], [90, 100]);
  assert.equal(r?.exact, true);
});

test("no match returns null", () => {
  assert.equal(parseTimeRangeSpec("make it cinematic"), null);
});

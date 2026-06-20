// Tests for the overlap add-flow translation (detect + resolve).

import { test } from "node:test";
import assert from "node:assert/strict";

import { detectFirstAddConflict, resolveAddConflict } from "./overlapFlow.ts";
import type { Highlight } from "../types.ts";
import type { NewClipInput } from "./operations.ts";

const hl = (over: Partial<Highlight>): Highlight => ({
  id: over.id ?? "h1",
  start: over.start ?? 0,
  end: over.end ?? 5,
  score: over.score ?? 1,
  reason: over.reason ?? "",
  transition: "none",
  confidence: "high",
  sourceId: over.sourceId ?? "src1",
  label: over.label
});

const inc = (over: Partial<NewClipInput>): NewClipInput => ({
  sourceId: over.sourceId ?? "src1",
  start: over.start ?? 0,
  end: over.end ?? 5,
  reason: over.reason ?? "added"
});

test("non-overlapping add → no conflict", () => {
  const current = [hl({ id: "a", start: 0, end: 5 })];
  assert.equal(detectFirstAddConflict(current, [inc({ start: 10, end: 15 })]), null);
});

test("cross-source clips never conflict", () => {
  const current = [hl({ id: "a", start: 0, end: 5, sourceId: "src1" })];
  assert.equal(detectFirstAddConflict(current, [inc({ start: 0, end: 5, sourceId: "src2" })]), null);
});

test("heavy same-source overlap → conflict detected", () => {
  const current = [hl({ id: "a", start: 0, end: 5 })];
  const c = detectFirstAddConflict(current, [inc({ start: 1, end: 6 })]);
  assert.ok(c);
  assert.equal(c!.conflict.existingClipId, "a");
});

test("keep_both → adds incoming, removes nothing", () => {
  const current = [hl({ id: "a", start: 0, end: 5 })];
  const c = detectFirstAddConflict(current, [inc({ start: 1, end: 6 })])!;
  const r = resolveAddConflict(c, "keep_both");
  assert.ok(r.toAdd);
  assert.equal(r.removeExistingId, null);
  assert.equal(r.applied, "keep_both");
});

test("replace_existing → adds incoming, removes the old clip", () => {
  const current = [hl({ id: "a", start: 0, end: 5 })];
  const c = detectFirstAddConflict(current, [inc({ start: 1, end: 6 })])!;
  const r = resolveAddConflict(c, "replace_existing");
  assert.ok(r.toAdd);
  assert.equal(r.removeExistingId, "a");
});

test("skip_new → nothing added", () => {
  const current = [hl({ id: "a", start: 0, end: 5 })];
  const c = detectFirstAddConflict(current, [inc({ start: 1, end: 6 })])!;
  const r = resolveAddConflict(c, "skip_new");
  assert.equal(r.toAdd, null);
  assert.equal(r.removeExistingId, null);
});

test("trim_new → adds a shortened, non-overlapping clip", () => {
  const current = [hl({ id: "a", start: 0, end: 5 })];
  // incoming 3..7 overlaps 3..5 (2s of a 4s clip = 50% → conflict); trimming
  // keeps the larger 5..7 non-overlapping side.
  const c = detectFirstAddConflict(current, [inc({ start: 3, end: 7 })])!;
  assert.ok(c, "expected a conflict");
  const r = resolveAddConflict(c, "trim_new");
  assert.ok(r.toAdd);
  assert.ok(r.toAdd!.start >= 5);
  assert.ok(r.toAdd!.end <= 7);
  assert.ok(r.toAdd!.end > r.toAdd!.start);
});

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectOverlapConflicts,
  decideOverlapResolution,
  applyResolution,
  buildOverlapQuestion,
  type OverlapClip
} from "./overlapResolver.ts";

const clip = (id: string, start: number, end: number, sourceId = "s1"): OverlapClip => ({ id, start, end, sourceId });

test("detects a strong same-source overlap as a conflict", () => {
  const existing = [clip("a", 10, 16)];
  const incoming = clip("b", 12, 18);
  const conflicts = detectOverlapConflicts(existing, incoming);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].existingClipId, "a");
  assert.ok(conflicts[0].overlapSeconds > 0);
});

test("ignores overlaps on a different source", () => {
  const existing = [clip("a", 10, 16, "s1")];
  const incoming = clip("b", 12, 18, "s2");
  assert.equal(detectOverlapConflicts(existing, incoming).length, 0);
});

test("small touching overlap below the ratio is NOT a conflict (coexist)", () => {
  const existing = [clip("a", 10, 20)];
  const incoming = clip("b", 19.5, 30); // 0.5s overlap of a 10.5s clip → tiny ratio
  assert.equal(detectOverlapConflicts(existing, incoming).length, 0);
});

test("default resolution for an ambiguous conflict is ask_user (no silent destruction)", () => {
  const existing = [clip("a", 10, 16)];
  const incoming = clip("b", 11, 17);
  const [conflict] = detectOverlapConflicts(existing, incoming);
  assert.equal(decideOverlapResolution(conflict), "ask_user");
  // applying ask_user changes nothing
  const r = applyResolution(existing, incoming, conflict, "ask_user");
  assert.deepEqual(r.clips, existing);
});

test("explicit keep_both is respected", () => {
  const existing = [clip("a", 10, 16)];
  const incoming = clip("b", 11, 17);
  const [conflict] = detectOverlapConflicts(existing, incoming);
  assert.equal(decideOverlapResolution(conflict, { userExplicit: "keep_both" }), "keep_both");
  const r = applyResolution(existing, incoming, conflict, "keep_both");
  assert.equal(r.clips.length, 2);
});

test("replace_existing removes the old clip and adds the new one", () => {
  const existing = [clip("a", 10, 16)];
  const incoming = clip("b", 11, 17);
  const [conflict] = detectOverlapConflicts(existing, incoming);
  const r = applyResolution(existing, incoming, conflict, "replace_existing");
  assert.equal(r.clips.length, 1);
  assert.equal(r.clips[0].id, "b");
});

test("trim_new keeps the larger non-overlapping side", () => {
  const existing = [clip("a", 10, 16)];
  const incoming = clip("b", 8, 14); // overlaps 10..14; left side 8..10 (2s), right side none
  const [conflict] = detectOverlapConflicts(existing, incoming);
  const r = applyResolution(existing, incoming, conflict, "trim_new");
  assert.equal(r.applied, "trim_new");
  const added = r.clips.find((c) => c.id === "b")!;
  assert.ok(added.end <= 10.0001);
});

test("buildOverlapQuestion offers non-destructive choices", () => {
  const existing = [clip("a", 10, 16)];
  const incoming = clip("b", 11, 17);
  const [conflict] = detectOverlapConflicts(existing, incoming);
  const q = buildOverlapQuestion(conflict);
  assert.match(q.message, /overlaps/i);
  assert.ok(q.suggestions.length >= 3);
});

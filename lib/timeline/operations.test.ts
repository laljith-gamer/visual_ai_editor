import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addClips,
  addClipRef,
  extendClip,
  moveClip,
  removeClip,
  replaceClip,
  trimClip
} from "./operations.ts";

interface Clip {
  id: string;
  start: number;
  end: number;
  score: number;
  reason: string;
  sourceId?: string;
  transition?: "none" | "fade" | "crossfade";
}

function clip(id: string, start: number, end: number, sourceId = "v1"): Clip {
  return { id, start, end, score: 1, reason: "x", sourceId };
}

// operations.ts is typed against Highlight; the shapes above are
// structurally compatible for these tests.
/* eslint-disable @typescript-eslint/no-explicit-any */
const base = [clip("c1", 0, 5), clip("c2", 10, 15), clip("c3", 20, 25)] as any[];

test("add range appends and does not mutate input", () => {
  const r = addClips(base, [{ sourceId: "v1", start: 30, end: 40, reason: "added" }]);
  assert.equal(r.changed, 1);
  assert.equal(r.highlights.length, 4);
  assert.equal(base.length, 3, "original array must be untouched");
  assert.equal(r.createdClipIds.length, 1);
});

test("add at index inserts (placement)", () => {
  const r = addClips(base, [{ sourceId: "v1", start: 7, end: 9, reason: "mid" }], 1);
  assert.equal(r.highlights[1].reason, "mid");
});

test("move clip reorders", () => {
  const r = moveClip(base, "c3", 0);
  assert.equal(r.highlights[0].id, "c3");
  assert.equal(r.changed, 1);
});

test("replace clip keeps position, new id", () => {
  const r = replaceClip(base, "c2", { sourceId: "v1", start: 11, end: 14, reason: "new" });
  assert.equal(r.highlights.length, 3);
  assert.equal(r.highlights[1].reason, "new");
  assert.notEqual(r.highlights[1].id, "c2");
});

test("remove clip drops it", () => {
  const r = removeClip(base, "c2");
  assert.equal(r.highlights.length, 2);
  assert.ok(!r.highlights.some((h) => h.id === "c2"));
});

test("add clip ref duplicates after a position", () => {
  const r = addClipRef(base, "c1", 3);
  assert.equal(r.highlights.length, 4);
  assert.equal(r.changed, 1);
});

test("extend clip widens bounds (clamped to source)", () => {
  const r = extendClip(base, "c1", { beforeSeconds: 2, afterSeconds: 3, sourceDuration: 300 });
  const c1 = r.highlights.find((h) => h.id === "c1")!;
  assert.equal(c1.start, 0); // already at 0, can't go before
  assert.equal(c1.end, 8);
});

test("trim clip to explicit window", () => {
  const r = trimClip(base, "c3", 21, 23);
  const c3 = r.highlights.find((h) => h.id === "c3")!;
  assert.equal(c3.start, 21);
  assert.equal(c3.end, 23);
});

test("first clip transition normalized to none", () => {
  const r = addClips(base, [{ sourceId: "v1", start: 30, end: 40, reason: "added" }]);
  assert.equal(r.highlights[0].transition, "none");
});

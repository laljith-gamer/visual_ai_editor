import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAutoBoundaryTransitions } from "./timeline.ts";
import type { TransitionClip } from "./features.ts";
import type { BoundaryTransition } from "./types.ts";

const c = (id: string, sourceId: string, start: number, end: number): TransitionClip => ({
  id,
  sourceId,
  start,
  end
});

test("N clips → N-1 boundary transitions (indices 1..N-1)", () => {
  const clips = [c("a", "v1", 0, 5), c("b", "v1", 5, 10), c("c", "v2", 0, 5), c("d", "v2", 5, 10)];
  const bts = buildAutoBoundaryTransitions(clips);
  assert.equal(bts.length, 3);
  assert.deepEqual(bts.map((b) => b.index), [1, 2, 3]);
  assert.ok(bts.every((b) => b.mode === "auto"));
});

test("one clip → no transitions", () => {
  assert.deepEqual(buildAutoBoundaryTransitions([c("a", "v1", 0, 5)]), []);
  assert.deepEqual(buildAutoBoundaryTransitions([]), []);
});

test("manual transition survives recompute when its boundary still exists", () => {
  const clips = [c("a", "v1", 0, 5), c("b", "v1", 5, 10), c("c", "v2", 0, 5)];
  const existing: BoundaryTransition[] = [{ index: 1, type: "zoom", mode: "manual" }];
  const bts = buildAutoBoundaryTransitions(clips, { existing });
  const b1 = bts.find((b) => b.index === 1)!;
  assert.equal(b1.type, "zoom");
  assert.equal(b1.mode, "manual");
  // honest mapping still applied to the preserved manual pick
  assert.equal(b1.render, "crossfade");
  assert.equal(b1.exact, false);
  assert.ok(b1.note);
});

test("removing a clip drops the now-missing boundary (incl. its manual override)", () => {
  const existing: BoundaryTransition[] = [
    { index: 1, type: "fade", mode: "manual" },
    { index: 2, type: "zoom", mode: "manual" }
  ];
  // Only 2 clips now → a single boundary at index 1; index-2 manual is gone.
  const bts = buildAutoBoundaryTransitions([c("a", "v1", 0, 5), c("b", "v1", 5, 10)], { existing });
  assert.equal(bts.length, 1);
  assert.equal(bts[0].index, 1);
  assert.equal(bts[0].type, "fade");
  assert.ok(!bts.some((b) => b.index === 2));
});

test("duration is clamped so it can't eat a short clip", () => {
  // 0.5s clip → max transition 0.4 * 0.5 = 0.2s.
  const bts = buildAutoBoundaryTransitions([c("a", "v1", 0, 0.5), c("b", "v1", 0.5, 1)]);
  assert.ok(bts[0].durationSeconds !== undefined && bts[0].durationSeconds <= 0.2 + 1e-9);
});

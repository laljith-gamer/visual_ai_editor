import { test } from "node:test";
import assert from "node:assert/strict";
import { combineConfidence, decideAction } from "./policy.ts";

test("high confidence → execute", () => {
  assert.equal(decideAction(0.9), "execute");
  assert.equal(decideAction(0.85), "execute");
});

test("medium confidence → execute_with_note", () => {
  assert.equal(decideAction(0.7), "execute_with_note");
  assert.equal(decideAction(0.65), "execute_with_note");
});

test("low confidence → clarify", () => {
  assert.equal(decideAction(0.5), "clarify");
  assert.equal(decideAction(0.64), "clarify");
});

test("combineConfidence uses weakest link", () => {
  assert.equal(combineConfidence([0.9, 0.9, 0.9]), 0.9);
  assert.equal(combineConfidence([0.9, 0.6]), 0.6);
});

test("combineConfidence penalizes multiple uncertain parts", () => {
  // three parts < 0.85 → penalty (3-1)*0.05 = 0.1 off the min (0.6) → 0.5
  const c = combineConfidence([0.6, 0.6, 0.6]);
  assert.ok(Math.abs(c - 0.5) < 1e-9, `expected ~0.5, got ${c}`);
});

test("combineConfidence ignores zero parts", () => {
  assert.equal(combineConfidence([0, 0.9]), 0.9);
  assert.equal(combineConfidence([]), 0);
});

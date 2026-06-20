import { test } from "node:test";
import assert from "node:assert/strict";

import { trimHighlightsToTarget } from "./trimToTarget.ts";
import type { Highlight } from "../types.ts";

const hl = (id: string, start: number, end: number, score: number): Highlight => ({
  id,
  start,
  end,
  score,
  reason: "",
  transition: "none",
  confidence: "high",
  sourceId: "src1"
});

test("already-under timeline is untouched", () => {
  const hs = [hl("a", 0, 5, 0.9), hl("b", 10, 13, 0.8)];
  const r = trimHighlightsToTarget(hs, 60);
  assert.equal(r.alreadyUnder, true);
  assert.equal(r.removedCount, 0);
  assert.equal(r.kept.length, 2);
});

test("strongest strategy keeps highest-scoring clips up to target, preserves order", () => {
  const hs = [
    hl("a", 0, 10, 0.3),
    hl("b", 20, 30, 0.9),
    hl("c", 40, 50, 0.8),
    hl("d", 60, 70, 0.2)
  ]; // 40s total, target 20s
  const r = trimHighlightsToTarget(hs, 20, { strategy: "strongest" });
  assert.equal(r.alreadyUnder, false);
  assert.ok(r.totalAfter <= 21);
  // keeps b (0.9) and c (0.8), in original order
  assert.deepEqual(r.kept.map((h) => h.id), ["b", "c"]);
});

test("order strategy keeps leading clips until budget", () => {
  const hs = [hl("a", 0, 10, 0.3), hl("b", 20, 30, 0.9), hl("c", 40, 50, 0.8)];
  const r = trimHighlightsToTarget(hs, 10, { strategy: "order" });
  assert.deepEqual(r.kept.map((h) => h.id), ["a"]);
});

test("never removes the only clip", () => {
  const hs = [hl("a", 0, 120, 1)];
  const r = trimHighlightsToTarget(hs, 30);
  assert.equal(r.kept.length, 1);
});

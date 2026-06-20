// Tests for deriving the multi-video GlobalPlanRequest from text.

import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveGlobalPlanRequest } from "./globalPlanRequest.ts";

test("cinematic/story wording → story style", () => {
  assert.equal(deriveGlobalPlanRequest("make a cinematic story from all videos", "normal").style, "story");
  assert.equal(deriveGlobalPlanRequest("build a narrative from these", "normal").style, "story");
});

test("montage wording → montage style", () => {
  assert.equal(deriveGlobalPlanRequest("make a fast montage", "normal").style, "montage");
  assert.equal(deriveGlobalPlanRequest("quick cuts of everything", "normal").style, "montage");
});

test("best-only wording → bestOnly true", () => {
  assert.equal(deriveGlobalPlanRequest("just the best from all videos", "normal").bestOnly, true);
  assert.equal(deriveGlobalPlanRequest("only the most action", "normal").bestOnly, true);
});

test("plain 'make a reel from all videos' → unknown style, not best-only", () => {
  const r = deriveGlobalPlanRequest("make a reel from all videos", "normal");
  assert.equal(r.style, "unknown");
  assert.equal(r.bestOnly, false);
});

test("specificity is passed through", () => {
  assert.equal(deriveGlobalPlanRequest("make it cool from all", "vague").promptSpecificity, "vague");
});

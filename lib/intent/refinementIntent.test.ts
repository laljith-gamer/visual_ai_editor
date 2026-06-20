import { test } from "node:test";
import assert from "node:assert/strict";

import { detectRefinement } from "./refinementIntent.ts";

test("remove + keep-only is a filter with include/exclude (typos normalized)", () => {
  const r = detectRefinement("remove cutsecene i need only fighting scene");
  assert.equal(r.kind, "filter");
  assert.ok(r.exclude.includes("cutscene"));
  assert.ok(r.include.includes("fighting"));
});

test("remove-only content", () => {
  const r = detectRefinement("remove all boring parts make video for 1 min");
  assert.equal(r.kind, "remove");
  assert.ok(r.exclude.includes("boring"));
  assert.deepEqual(r.include, []);
});

test("keep-only content", () => {
  const r = detectRefinement("only combat");
  assert.equal(r.kind, "keep_only");
  assert.ok(r.include.includes("combat"));
});

test("second phrasing with typos: remove cutsecene i don't need it only comabt", () => {
  const r = detectRefinement("remove cutsecene i don't need it only comabt");
  assert.equal(r.kind, "filter");
  assert.ok(r.exclude.includes("cutscene"));
  assert.ok(r.include.includes("combat"));
});

test("trim to fit is trim_to_target", () => {
  const r = detectRefinement("trim to fit");
  assert.equal(r.kind, "trim_to_target");
});

test("scope-only answer resolves current scope", () => {
  const r = detectRefinement("from current video clips");
  assert.equal(r.kind, "scope_only");
  assert.equal(r.scope, "current_video");
});

test("defers specific clip-index edits (clip 2) to the clip path", () => {
  assert.equal(detectRefinement("remove clip 2").kind, "none");
  assert.equal(detectRefinement("remove this clip").kind, "none");
});

test("a plain new-search request is not a refinement", () => {
  assert.equal(detectRefinement("give me red boy and wukong fight best combat scene for 2 min").kind, "none");
});

test("scope phrasing for current timeline", () => {
  assert.equal(detectRefinement("use current timeline").scope, "current_timeline");
});

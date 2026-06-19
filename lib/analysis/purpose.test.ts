import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyAnalysisPurpose, type PurposeContext } from "./purpose.ts";

const ctx = (over: Partial<PurposeContext> = {}): PurposeContext => ({
  sourceCount: 1,
  hasTimeline: false,
  ...over
});

test("'describe what's in this video' → quick_describe", () => {
  const r = classifyAnalysisPurpose("describe what's in this video", ctx());
  assert.equal(r.purpose, "quick_describe");
});

test("'summarize the footage' → quick_describe", () => {
  assert.equal(classifyAnalysisPurpose("summarize the footage", ctx()).purpose, "quick_describe");
});

test("'add first 30 seconds' → none (no frame analysis)", () => {
  const r = classifyAnalysisPurpose("add first 30 seconds", ctx());
  assert.equal(r.purpose, "none");
  assert.equal(r.specificity, "exact");
});

test("'keep 00:10 to 00:40' → none", () => {
  assert.equal(classifyAnalysisPurpose("keep 00:10 to 00:40", ctx()).purpose, "none");
});

test("'merge all videos' → none", () => {
  assert.equal(classifyAnalysisPurpose("merge all videos", ctx({ sourceCount: 3 })).purpose, "none");
});

test("'render' → none", () => {
  assert.equal(classifyAnalysisPurpose("render", ctx()).purpose, "none");
});

test("'why did you choose this clip' (read-only) → none", () => {
  assert.equal(classifyAnalysisPurpose("why did you choose this clip", ctx({ hasTimeline: true })).purpose, "none");
});

test("'pick best parts' → normal_highlights", () => {
  assert.equal(classifyAnalysisPurpose("pick best parts", ctx()).purpose, "normal_highlights");
});

test("'make a 30 sec reel' → normal_highlights", () => {
  assert.equal(classifyAnalysisPurpose("make a 30 sec reel", ctx()).purpose, "normal_highlights");
});

test("'find the red car' → specific_visual_search with topic", () => {
  const r = classifyAnalysisPurpose("find the red car", ctx());
  assert.equal(r.purpose, "specific_visual_search");
  assert.ok((r.topic ?? "").includes("red") || (r.topic ?? "").includes("car"));
});

test("'the part where he says subscribe' → transcript_search", () => {
  assert.equal(classifyAnalysisPurpose("add the part where he says subscribe", ctx()).purpose, "transcript_search");
});

test("'make a cinematic story from all videos' → deep_story", () => {
  const r = classifyAnalysisPurpose("make a cinematic story from all videos", ctx({ sourceCount: 3 }));
  assert.equal(r.purpose, "deep_story");
});

test("'make this cool' → normal_highlights, vague specificity", () => {
  const r = classifyAnalysisPurpose("make this cool", ctx());
  assert.equal(r.purpose, "normal_highlights");
  assert.equal(r.specificity, "vague");
});

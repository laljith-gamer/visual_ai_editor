import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDescribeResponse, type DescribeState } from "./describeResponder.ts";
import { createVideoMemory, mergeVideoMemory } from "../analysis/videoMemory.ts";

const base = (over: Partial<DescribeState> = {}): DescribeState => ({
  hasVideo: true,
  sourceName: "clip.mp4",
  durationSeconds: 90,
  width: 1080,
  height: 1920,
  ...over
});

test("no video → asks to upload, never claims content", () => {
  const r = buildDescribeResponse(base({ hasVideo: false }));
  assert.match(r.message, /upload/i);
  assert.equal(r.suggestions.length, 0);
});

test("no analysis yet → honest, offers quick local scan, no fabricated content", () => {
  const r = buildDescribeResponse(base());
  assert.match(r.message, /haven't scanned|haven.t scanned/i);
  assert.ok(r.suggestions.some((s) => /quick local scan/i.test(s)));
  assert.ok(r.suggestions.some((s) => /motion-based/i.test(s)));
  assert.equal(r.needsMore, true);
  // must not pretend to know subjects
  assert.doesNotMatch(r.message, /\bi see a\b/i);
});

test("includes the file facts it actually knows (duration/resolution)", () => {
  const r = buildDescribeResponse(base({ durationSeconds: 125 }));
  assert.match(r.message, /2:05/);
  assert.match(r.message, /1080×1920/);
});

test("with a transcript → offers to search what's said", () => {
  const r = buildDescribeResponse(base({ hasTranscript: true }));
  assert.ok(r.suggestions.some((s) => /said/i.test(s)));
});

test("with cached scan memory → describes structurally + admits no captions", () => {
  const mem = mergeVideoMemory(
    createVideoMemory({ videoHash: "h", sourceId: "s", sourceName: "clip.mp4", durationSeconds: 90, updatedAt: 1 }),
    { level: 2, confidence: 0.6, sceneMap: [{ start: 0, end: 45 }, { start: 45, end: 90 }], motionPeaks: [{ start: 5, end: 9, score: 0.8 }] }
  );
  const r = buildDescribeResponse(base({ memory: mem }));
  assert.match(r.message, /scenes|motion|scan level/i);
  assert.match(r.message, /captioning|name the subjects/i);
});

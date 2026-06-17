import { test } from "node:test";
import assert from "node:assert/strict";
import { safeTitleSegment, exportTimestamp, buildExportFilename } from "./download.ts";

test("safeTitleSegment slugifies titles", () => {
  assert.equal(safeTitleSegment("My Holiday Video.mp4"), "my-holiday-video-mp4");
  assert.equal(safeTitleSegment("  Trip 2026!! "), "trip-2026");
  assert.equal(safeTitleSegment("a/b\\c:d*e"), "a-b-c-d-e");
});

test("safeTitleSegment falls back to 'untitled'", () => {
  assert.equal(safeTitleSegment(""), "untitled");
  assert.equal(safeTitleSegment(null), "untitled");
  assert.equal(safeTitleSegment("   "), "untitled");
  assert.equal(safeTitleSegment("***"), "untitled");
});

test("safeTitleSegment caps length and trims trailing dashes", () => {
  const seg = safeTitleSegment("x".repeat(100));
  assert.ok(seg.length <= 40, `len ${seg.length}`);
  assert.ok(!seg.endsWith("-"));
});

test("exportTimestamp is yyyyMMdd-HHmmss", () => {
  const d = new Date(2026, 5, 18, 9, 7, 3); // 2026-06-18 09:07:03 local
  assert.equal(exportTimestamp(d), "20260618-090703");
});

test("buildExportFilename is deterministic", () => {
  const d = new Date(2026, 5, 18, 9, 7, 3);
  assert.equal(buildExportFilename("My Reel", d), "shorts-studio-my-reel-20260618-090703.mp4");
  assert.equal(buildExportFilename("", d), "shorts-studio-untitled-20260618-090703.mp4");
  assert.equal(buildExportFilename("My Reel", d, "webm"), "shorts-studio-my-reel-20260618-090703.webm");
});

// Tests for the professional video-prompt interpreter (issue #64).
//
// Run via the agentic-layer test runner (Node --test + --experimental-strip-
// types + the ts-ext hook, since this module value-imports ../config).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeVideoPromptText,
  parseDuration,
  parseClipCount,
  parseFormat,
  parsePlatform,
  parseSourceScope,
  isMeaningfulContentTopic,
  extractMeaningfulTopic,
  splitExclusions
} from "./videoPromptInterpreter.ts";

// ---------------------------------------------------------------------
// normalization
// ---------------------------------------------------------------------
test("normalize: fixes atleast/sect typos and reports evidence", () => {
  const r = normalizeVideoPromptText("atleast sect 5 clip from all");
  assert.ok(r.normalized.includes("at least"), r.normalized);
  assert.ok(r.normalized.includes("select"), r.normalized);
  assert.ok(r.evidence.some((e) => e.includes("at least")));
  assert.ok(r.evidence.some((e) => e.includes("select")));
});

test("normalize: 'sect' stays untouched without clip/video context", () => {
  const r = normalizeVideoPromptText("the sect of town");
  assert.ok(!/\bselect\b/.test(r.normalized), r.normalized);
});

test("normalize: spaces attached number+unit (5min → 5 min)", () => {
  assert.equal(normalizeVideoPromptText("make a 5min reel").normalized, "make a 5 min reel");
  assert.equal(normalizeVideoPromptText("40sec vertical").normalized, "40 sec vertical");
});

// ---------------------------------------------------------------------
// duration
// ---------------------------------------------------------------------
test("parseDuration: minutes / seconds / words / clock", () => {
  assert.equal(parseDuration("make it 5 min"), 300);
  assert.equal(parseDuration("combined 5 minutes video"), 300);
  assert.equal(parseDuration("five minutes"), 300);
  assert.equal(parseDuration("40 sec"), 40);
  assert.equal(parseDuration("from 1:30"), 90);
  assert.equal(parseDuration("no duration here"), null);
});

test("parseDuration: '5 clip' is not a duration", () => {
  assert.equal(parseDuration("at least 5 clip from all"), null);
});

// ---------------------------------------------------------------------
// clip count
// ---------------------------------------------------------------------
test("parseClipCount: at-least / plus / max / around / plain", () => {
  assert.equal(parseClipCount("at least 5 clips").minClipCount, 5);
  assert.equal(parseClipCount("minimum 5 pieces").minClipCount, 5);
  assert.equal(parseClipCount("5+ clips").minClipCount, 5);
  assert.equal(parseClipCount("max 5 clips").maxClipCount, 5);
  assert.equal(parseClipCount("no more than 5 clips").maxClipCount, 5);
  assert.equal(parseClipCount("around 5 clips").targetClipCount, 5);
  assert.equal(parseClipCount("select 5 clips").targetClipCount, 5);
});

test("parseClipCount: '5 min' is NOT a clip count; 'clip 5' is not either", () => {
  assert.deepEqual(parseClipCount("make it 5 min vertical"), {});
  assert.deepEqual(parseClipCount("remove clip 5"), {});
});

test("parseClipCount: normalized 'atleast sect 5 clip' → minClipCount 5", () => {
  const norm = normalizeVideoPromptText("atleast sect 5 clip from all").normalized;
  assert.equal(parseClipCount(norm).minClipCount, 5);
});

// ---------------------------------------------------------------------
// format / platform
// ---------------------------------------------------------------------
test("parseFormat: explicit + platform-implied", () => {
  assert.equal(parseFormat("make it vertical"), "vertical");
  assert.equal(parseFormat("9:16 please"), "vertical");
  assert.equal(parseFormat("landscape edit"), "horizontal");
  assert.equal(parseFormat("square 1:1"), "square");
  assert.equal(parseFormat("a tiktok"), "vertical");
  assert.equal(parseFormat("just a montage"), null);
});

test("parsePlatform: tiktok / reels / shorts / generic", () => {
  assert.equal(parsePlatform("make a tiktok"), "tiktok");
  assert.equal(parsePlatform("instagram reel"), "instagram_reels");
  assert.equal(parsePlatform("youtube shorts"), "youtube_shorts");
  assert.equal(parsePlatform("a combined video"), "generic");
});

// ---------------------------------------------------------------------
// source scope
// ---------------------------------------------------------------------
test("parseSourceScope: all-videos phrasing → all", () => {
  assert.equal(parseSourceScope("from all videos").type, "all");
  assert.equal(parseSourceScope("use all").type, "all");
  assert.equal(parseSourceScope("every upload").type, "all");
  assert.equal(parseSourceScope("each video").type, "all");
  assert.equal(parseSourceScope("from all").type, "all");
});

test("parseSourceScope: no scope → ambiguous", () => {
  assert.equal(parseSourceScope("make a 30s reel of dunks").type, "ambiguous");
  assert.equal(parseSourceScope("combat from the first video").type, "ambiguous");
});

// ---------------------------------------------------------------------
// meaningful topic — the core of issue #64
// ---------------------------------------------------------------------
test("meta-only phrases are NOT meaningful topics", () => {
  for (const phrase of [
    "atleast sect all",
    "min vertical",
    "5 min vertical",
    "all clips",
    "combined video",
    "best picks",
    "reel",
    "short",
    "dynamic transition"
  ]) {
    const norm = normalizeVideoPromptText(phrase).normalized;
    assert.equal(
      extractMeaningfulTopic(norm),
      null,
      `"${phrase}" should have no topic`
    );
    assert.equal(
      isMeaningfulContentTopic(norm.split(/\s+/)),
      false,
      `"${phrase}" should not be meaningful`
    );
  }
});

test("real subjects ARE meaningful topics", () => {
  for (const phrase of [
    "combat",
    "cutscene",
    "cooking ingredient",
    "reaction",
    "goal celebration",
    "intro",
    "product reveal",
    "funny moment"
  ]) {
    assert.ok(
      isMeaningfulContentTopic(phrase.split(/\s+/)),
      `"${phrase}" should be meaningful`
    );
    assert.ok(extractMeaningfulTopic(phrase), `"${phrase}" should extract`);
  }
});

test("extractMeaningfulTopic strips meta around a real subject", () => {
  assert.equal(extractMeaningfulTopic("take cooking parts from all videos and make 3 min vertical"), "cooking");
  assert.equal(extractMeaningfulTopic("pick combat in the first video"), "combat");
  assert.equal(extractMeaningfulTopic("best 5 clip 2 min vertical"), null);
});

// ---------------------------------------------------------------------
// exclusions
// ---------------------------------------------------------------------
test("splitExclusions: 'but avoid intro' excludes intro, keeps the rest", () => {
  const r = splitExclusions("make 1 min reel from all videos but avoid intro");
  assert.deepEqual(r.exclusions, ["intro"]);
  assert.ok(!r.keep.includes("intro"), r.keep);
  assert.equal(extractMeaningfulTopic(r.keep), null);
});

test("splitExclusions: no marker → empty exclusions", () => {
  const r = splitExclusions("cooking from all videos");
  assert.deepEqual(r.exclusions, []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSourceRef, resolveSource } from "./sourceResolver.ts";
import type { AgentCommandContext } from "./command.ts";

function ctx(partial: Partial<AgentCommandContext> = {}): AgentCommandContext {
  return {
    sources: [],
    activeSourceId: null,
    lastUsedSourceId: null,
    selectedSourceIds: [],
    highlights: [],
    selectedClipId: null,
    lastCreatedClipIds: [],
    transcriptAvailableSourceIds: [],
    ...partial
  };
}

const ONE = [{ id: "a", name: "holiday.mp4", duration: 300 }];
const TWO = [
  { id: "a", name: "podcast.mp4", duration: 600 },
  { id: "b", name: "gameplay.mp4", duration: 900 }
];

test("one video default → assume it, no clarify", () => {
  const r = resolveSource(null, ctx({ sources: ONE }));
  assert.deepEqual(r.sourceIds, ["a"]);
  assert.equal(r.needsClarification, false);
});

test("video 1 → first source", () => {
  const ref = parseSourceRef("add first 2 min from video 1");
  const r = resolveSource(ref, ctx({ sources: TWO }));
  assert.deepEqual(r.sourceIds, ["a"]);
});

test("second video → index 1", () => {
  const ref = parseSourceRef("use the second video");
  const r = resolveSource(ref, ctx({ sources: TWO }));
  assert.deepEqual(r.sourceIds, ["b"]);
});

test("active source when 'this video'", () => {
  const ref = parseSourceRef("clip this video");
  const r = resolveSource(ref, ctx({ sources: TWO, activeSourceId: "b" }));
  assert.deepEqual(r.sourceIds, ["b"]);
});

test("fuzzy name match", () => {
  const ref = parseSourceRef("use the gameplay one");
  assert.equal(ref?.kind, "name_hint");
  const r = resolveSource(ref, ctx({ sources: TWO }));
  assert.deepEqual(r.sourceIds, ["b"]);
});

test("ambiguous multi-source → clarify", () => {
  const r = resolveSource(null, ctx({ sources: TWO, activeSourceId: null, lastUsedSourceId: null }));
  assert.equal(r.needsClarification, true);
  assert.ok(r.suggestions && r.suggestions.length > 0);
});

test("multi-source with active → medium confidence + assumption", () => {
  const r = resolveSource(null, ctx({ sources: TWO, activeSourceId: "a" }));
  assert.deepEqual(r.sourceIds, ["a"]);
  assert.equal(r.needsClarification, false);
  assert.ok(r.confidence < 0.85 && r.confidence >= 0.65);
  assert.ok(r.assumptions.length > 0);
});

test("all videos", () => {
  const ref = parseSourceRef("merge all videos");
  const r = resolveSource(ref, ctx({ sources: TWO }));
  assert.deepEqual(r.sourceIds, ["a", "b"]);
});

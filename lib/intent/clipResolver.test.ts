import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClipRef, resolveClip } from "./clipResolver.ts";
import type { AgentCommandContext } from "./command.ts";

function ctx(partial: Partial<AgentCommandContext> = {}): AgentCommandContext {
  return {
    sources: [
      { id: "v1", name: "a.mp4", duration: 300 },
      { id: "v2", name: "b.mp4", duration: 300 }
    ],
    activeSourceId: "v1",
    lastUsedSourceId: "v1",
    selectedSourceIds: ["v1", "v2"],
    highlights: [
      { id: "c1", start: 0, end: 5, sourceId: "v1" },
      { id: "c2", start: 10, end: 15, sourceId: "v1" },
      { id: "c3", start: 0, end: 4, sourceId: "v2" }
    ],
    selectedClipId: "c2",
    lastCreatedClipIds: ["c3"],
    transcriptAvailableSourceIds: [],
    ...partial
  };
}

test("clip 1 → first highlight", () => {
  const ref = parseClipRef("clip 1");
  const r = resolveClip(ref!, ctx());
  assert.equal(r.clipId, "c1");
});

test("last clip", () => {
  const ref = parseClipRef("the last clip");
  const r = resolveClip(ref!, ctx());
  assert.equal(r.clipId, "c3");
});

test("selected clip → this clip", () => {
  const ref = parseClipRef("this clip");
  const r = resolveClip(ref!, ctx());
  assert.equal(r.clipId, "c2");
});

test("that clip → last created", () => {
  const ref = parseClipRef("remove that clip");
  const r = resolveClip(ref!, ctx());
  assert.equal(r.clipId, "c3");
});

test("clip 2 from video 1 → index in source", () => {
  const ref = parseClipRef("clip 2 from video 1");
  assert.equal(ref?.kind, "index_in_source");
  const r = resolveClip(ref!, ctx());
  assert.equal(r.clipId, "c2");
});

test("clip out of range → clarify", () => {
  const ref = parseClipRef("clip 9");
  const r = resolveClip(ref!, ctx());
  assert.equal(r.clipId, null);
  assert.equal(r.needsClarification, true);
});

// Tests for the PURE project-history restore helpers. Run via the agentic
// test runner (node --test --experimental-strip-types + ts-ext hook).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  migrateSessionToManifests,
  buildRestoredProjectState,
  backfillHighlightSources,
  resolveUploadIdentity,
  usedMissingSources,
  canRenderTimeline,
  summarizeSession,
  buildPersistManifests,
  placeholderFromManifest,
  manifestFromSource,
  briefingStillValid
} from "./projectRestore.ts";
import type {
  Highlight,
  PersistedSourceManifest,
  Session,
  VideoSourceMeta
} from "../types.ts";

const meta = (name: string): VideoSourceMeta => ({
  name,
  size: 1000,
  duration: 120,
  width: 1920,
  height: 1080,
  aspect: "16:9"
});

const hl = (id: string, sourceId?: string): Highlight => ({
  id,
  start: 0,
  end: 5,
  score: 0.9,
  reason: "test",
  sourceId
});

function baseSession(over: Partial<Session>): Session {
  return {
    id: "sess_1",
    title: "Test project",
    createdAt: 1000,
    updatedAt: 2000,
    memory: { styles: [], keep: [], skip: [] },
    highlights: [],
    messages: [],
    status: "idle",
    progress: 0,
    ...over
  };
}

// 1. v1 session (videoMeta + videoHash) migrates to one manifest --------
test("v1 session with videoMeta/videoHash migrates to one source manifest", () => {
  const session = baseSession({
    videoMeta: { name: "old.mp4", size: 2048, duration: 90, width: 1280, height: 720 },
    videoHash: "abc123def456",
    highlights: [hl("c1"), hl("c2")]
  });
  const manifests = migrateSessionToManifests(session);
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].hash, "abc123def456");
  assert.equal(manifests[0].lastKnownName, "old.mp4");
  assert.equal(manifests[0].status, "missing");
});

// 2. v1.6 session with sources[] migrates to manifests ------------------
test("v1.6 session with sources[] migrates to source manifests", () => {
  const session = baseSession({
    sources: [
      { id: "src_a", hash: "h_a", meta: meta("a.mp4"), addedAt: 10 },
      { id: "src_b", hash: "h_b", meta: meta("b.mp4"), addedAt: 20 }
    ]
  });
  const manifests = migrateSessionToManifests(session);
  assert.deepEqual(manifests.map((m) => m.id), ["src_a", "src_b"]);
  assert.deepEqual(manifests.map((m) => m.hash), ["h_a", "h_b"]);
  assert.equal(manifests[0].lastKnownName, "a.mp4");
});

// 13. restoring old sessions remains backward-compatible ----------------
test("v2 sourceManifests take precedence and round-trip", () => {
  const manifests: PersistedSourceManifest[] = [
    { id: "src_a", hash: "h_a", meta: meta("a.mp4"), addedAt: 10, lastKnownName: "a.mp4", status: "available" }
  ];
  const session = baseSession({ schemaVersion: 2, sourceManifests: manifests });
  const out = migrateSessionToManifests(session);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "src_a");
  // Save-time availability is preserved (the history summary needs it);
  // the restore path turns everything into placeholders regardless.
  assert.equal(out[0].status, "available");
});

// 3 + 9. restore preserves highlights + backfills legacy sourceId -------
test("restoreSession preserves highlights even when sources are missing", () => {
  const session = baseSession({
    videoMeta: { name: "old.mp4", size: 2048, duration: 90, width: 1280, height: 720 },
    videoHash: "hash_legacy",
    highlights: [hl("c1"), hl("c2"), hl("c3")]
  });
  const restored = buildRestoredProjectState(session);
  assert.equal(restored.highlights.length, 3);
  assert.equal(restored.missingSources.length, 1);
  assert.equal(restored.missingSources[0].missing, true);
  // Legacy untagged highlights are backfilled to the single source id.
  const id = restored.manifests[0].id;
  assert.ok(restored.highlights.every((h) => h.sourceId === id));
});

test("highlights referencing old source id remain valid after hydration", () => {
  const session = baseSession({
    sources: [{ id: "src_a", hash: "h_a", meta: meta("a.mp4"), addedAt: 10 }],
    highlights: [hl("c1", "src_a"), hl("c2", "src_a")]
  });
  const restored = buildRestoredProjectState(session);
  // Before hydration: cannot render (source missing).
  assert.equal(canRenderTimeline(restored.highlights, new Set()), false);
  // After hydrating src_a: every clip resolves.
  assert.equal(canRenderTimeline(restored.highlights, new Set(["src_a"])), true);
});

// 4. uploading matching hash hydrates existing source id ----------------
test("uploading a file with matching hash hydrates the existing source id", () => {
  const session = baseSession({
    sources: [{ id: "src_a", hash: "h_match", meta: meta("a.mp4"), addedAt: 10 }]
  });
  const { missingSources } = buildRestoredProjectState(session);
  const decision = resolveUploadIdentity(missingSources, "h_match");
  assert.equal(decision.kind, "hydrate");
  if (decision.kind === "hydrate") {
    assert.equal(decision.placeholder.id, "src_a");
  }
});

// 5. uploading a non-matching file creates a new source id --------------
test("uploading a non-matching file creates a new source", () => {
  const session = baseSession({
    sources: [{ id: "src_a", hash: "h_a", meta: meta("a.mp4"), addedAt: 10 }]
  });
  const { missingSources } = buildRestoredProjectState(session);
  const decision = resolveUploadIdentity(missingSources, "different_hash");
  assert.equal(decision.kind, "new");
});

// 6. render guard blocks render when timeline uses missing source -------
test("render guard blocks render when a clip uses a missing source", () => {
  const highlights = [hl("c1", "src_a"), hl("c2", "src_b")];
  const missing = [
    placeholderFromManifest({ id: "src_b", hash: "h_b", meta: meta("b.mp4"), addedAt: 20, lastKnownName: "b.mp4" })
  ];
  // src_a hydrated, src_b missing.
  assert.equal(canRenderTimeline(highlights, new Set(["src_a"])), false);
  const used = usedMissingSources(highlights, missing, new Set(["src_a"]));
  assert.equal(used.length, 1);
  assert.equal(used[0].id, "src_b");
  // Both hydrated → renderable.
  assert.equal(canRenderTimeline(highlights, new Set(["src_a", "src_b"])), true);
});

test("render guard is false for an empty timeline", () => {
  assert.equal(canRenderTimeline([], new Set(["src_a"])), false);
});

// 7. selectedSourceIds restore -----------------------------------------
test("selectedSourceIds are restored (and filtered to known sources)", () => {
  const session = baseSession({
    sources: [
      { id: "src_a", hash: "h_a", meta: meta("a.mp4"), addedAt: 10 },
      { id: "src_b", hash: "h_b", meta: meta("b.mp4"), addedAt: 20 }
    ],
    selectedSourceIds: ["src_b", "ghost_id"],
    activeSourceId: "src_b"
  });
  const restored = buildRestoredProjectState(session);
  assert.deepEqual(restored.selectedSourceIds, ["src_b"]);
});

// 8. activeSourceId restore --------------------------------------------
test("activeSourceId is restored", () => {
  const session = baseSession({
    sources: [
      { id: "src_a", hash: "h_a", meta: meta("a.mp4"), addedAt: 10 },
      { id: "src_b", hash: "h_b", meta: meta("b.mp4"), addedAt: 20 }
    ],
    activeSourceId: "src_b"
  });
  const restored = buildRestoredProjectState(session);
  assert.equal(restored.activeSourceId, "src_b");
});

test("single-video restore defaults active + selected to the only source", () => {
  const session = baseSession({
    videoMeta: { name: "solo.mp4", size: 10, duration: 30, width: 1080, height: 1920 },
    videoHash: "h_solo",
    highlights: [hl("c1")]
  });
  const restored = buildRestoredProjectState(session);
  const id = restored.manifests[0].id;
  assert.equal(restored.activeSourceId, id);
  assert.deepEqual(restored.selectedSourceIds, [id]);
});

// 11. missing placeholder does not create an object URL -----------------
test("missing placeholder carries no blob and no url", () => {
  const ph = placeholderFromManifest({
    id: "src_a",
    hash: "h_a",
    meta: meta("a.mp4"),
    addedAt: 10,
    lastKnownName: "a.mp4"
  });
  assert.equal(Object.prototype.hasOwnProperty.call(ph, "url"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(ph, "blob"), false);
  assert.equal(ph.missing, true);
});

// 12. persist combines hydrated + missing into manifests ----------------
test("persist manifests combine hydrated (available) and missing sources", () => {
  const hydrated = [
    { id: "src_a", hash: "h_a", meta: meta("a.mp4"), addedAt: 10 }
  ];
  const missing = [
    placeholderFromManifest({ id: "src_b", hash: "h_b", meta: meta("b.mp4"), addedAt: 20, lastKnownName: "b.mp4" })
  ];
  const manifests = buildPersistManifests(hydrated, missing);
  assert.equal(manifests.length, 2);
  assert.equal(manifests[0].id, "src_a");
  assert.equal(manifests[0].status, "available");
  assert.equal(manifests[1].id, "src_b");
  assert.equal(manifests[1].status, "missing");
  // Round-trips back through migration unchanged.
  const session = baseSession({ schemaVersion: 2, sourceManifests: manifests });
  assert.deepEqual(migrateSessionToManifests(session).map((m) => m.id), ["src_a", "src_b"]);
});

test("persist manifests de-dupe an id present in both lists", () => {
  const hydrated = [{ id: "src_a", hash: "h_a", meta: meta("a.mp4"), addedAt: 10 }];
  const missing = [
    placeholderFromManifest({ id: "src_a", hash: "h_a", meta: meta("a.mp4"), addedAt: 10, lastKnownName: "a.mp4" })
  ];
  const manifests = buildPersistManifests(hydrated, missing);
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].status, "available");
});

// History summary -------------------------------------------------------
test("summarizeSession reports sources, clips, duration, format, last action", () => {
  const session = baseSession({
    sources: [
      { id: "src_a", hash: "h_a", meta: meta("a.mp4"), addedAt: 10 },
      { id: "src_b", hash: "h_b", meta: meta("b.mp4"), addedAt: 20 }
    ],
    highlights: [
      { id: "c1", start: 0, end: 5, score: 1, reason: "", sourceId: "src_a" },
      { id: "c2", start: 10, end: 18, score: 1, reason: "", sourceId: "src_b" }
    ],
    plan: {
      scenarios: [],
      labelWeights: {},
      targetShortSeconds: 30,
      userSpecifiedDuration: true,
      maxClipSeconds: 8,
      minClipSeconds: 1,
      selectionStrategy: "best",
      format: "vertical",
      transition: "fade",
      styles: [],
      avoid: [],
      sampleEverySeconds: 1,
      inferenceWidth: 224
    },
    messages: [
      { id: "m1", role: "user", content: "make a reel", timestamp: 1 },
      { id: "m2", role: "assistant", content: "ok", timestamp: 2 }
    ]
  });
  const sum = summarizeSession(session);
  assert.equal(sum.sourceCount, 2);
  assert.equal(sum.clipCount, 2);
  assert.equal(sum.totalDurationSeconds, 13);
  assert.equal(sum.format, "vertical");
  assert.equal(sum.lastAction, "make a reel");
});

// Misc guards -----------------------------------------------------------
test("backfillHighlightSources only acts on a single-manifest session", () => {
  const manifests: PersistedSourceManifest[] = [
    { id: "src_a", hash: "h_a", meta: meta("a.mp4"), addedAt: 10, lastKnownName: "a.mp4" },
    { id: "src_b", hash: "h_b", meta: meta("b.mp4"), addedAt: 20, lastKnownName: "b.mp4" }
  ];
  const highlights = [hl("c1"), hl("c2")];
  // Two manifests → ambiguous → unchanged.
  assert.equal(backfillHighlightSources(highlights, manifests), highlights);
});

test("briefingStillValid only when its source is a known manifest", () => {
  const manifests = [manifestFromSource({ id: "src_a", hash: "h_a", meta: meta("a.mp4"), addedAt: 10 })];
  assert.equal(briefingStillValid({ sourceId: "src_a", bestParts: [] }, manifests), true);
  assert.equal(briefingStillValid({ sourceId: "gone", bestParts: [] }, manifests), false);
  assert.equal(briefingStillValid(null, manifests), false);
});

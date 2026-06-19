// Tests for the PURE project-persistence signature. Run via the agentic
// test runner (node --test --experimental-strip-types + ts-ext hook).
//
// The signature drives the editor's autosave: a changed signature means the
// project must be persisted. These tests pin the acceptance criteria — every
// durable field changes the signature, and `progress` does NOT.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  projectPersistSignature,
  type ProjectSignatureInput
} from "./projectSignature.ts";
import type { EditPlan } from "../types.ts";

function plan(): EditPlan {
  return {
    scenarios: [{ id: "s1", prompt: "combat", weight: 1 }],
    labelWeights: { s1: 1 },
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
  };
}

/** Base input with at least one source + clip so mutations are meaningful.
 *  Carries an extra `progress` field (ignored by the signature) so the
 *  "progress doesn't change the signature" test can flip it. */
function base(): ProjectSignatureInput & { progress: number } {
  return {
    sessionId: "sess_1",
    title: "Project",
    sources: [{ id: "src_a", hash: "h_a", meta: { name: "a.mp4" }, addedAt: 10 }],
    missingSources: [{ id: "src_b", hash: "h_b" }],
    activeSourceId: "src_a",
    selectedSourceIds: ["src_a"],
    plan: plan(),
    highlights: [
      { id: "c1", start: 0, end: 5, score: 1, reason: "", sourceId: "src_a" }
    ],
    selectedClipId: "c1",
    boundaryTransitions: [{ index: 1, type: "fade", mode: "auto", durationSeconds: 0.4 }],
    pendingTimelineOp: "replace",
    pendingExecution: false,
    mode: "plan",
    inferred: [{ field: "format", value: "vertical", reason: "portrait source" }],
    userTier: "novice",
    lastBriefing: { id: "b1", sourceId: "src_a", bestParts: [{}, {}] },
    messages: [{ id: "m1", role: "user", content: "hi", timestamp: 1 }],
    memory: { styles: [], keep: [], skip: [] },
    status: "idle",
    progress: 0
  };
}

const sig = projectPersistSignature;

test("signature is deterministic for the same input", () => {
  const s = base();
  assert.equal(sig(s), sig(s));
  assert.equal(sig(base()), sig(base()));
});

// 1. Uploading a source changes the signature.
test("uploading a source changes the signature", () => {
  const before = sig(base());
  const s = base();
  s.sources = [
    ...s.sources,
    { id: "src_c", hash: "h_c", meta: { name: "c.mp4" }, addedAt: 30 }
  ];
  assert.notEqual(sig(s), before);
});

// 2. Hydrating a restored source changes the signature.
//    (placeholder moves out of missing into sources, keeping its id)
test("hydrating a restored source changes the signature", () => {
  const before = sig(base());
  const s = base();
  s.missingSources = []; // src_b hydrated…
  s.sources = [
    ...s.sources,
    { id: "src_b", hash: "h_b", meta: { name: "b.mp4" }, addedAt: 20 }
  ];
  assert.notEqual(sig(s), before);
});

// 3. Removing a missing source changes the signature.
test("removing a missing source changes the signature", () => {
  const before = sig(base());
  const s = base();
  s.missingSources = [];
  assert.notEqual(sig(s), before);
});

// 4. Changing activeSourceId changes the signature.
test("changing activeSourceId changes the signature", () => {
  const before = sig(base());
  const s = base();
  s.activeSourceId = "src_b";
  assert.notEqual(sig(s), before);
});

// 5. Changing selectedSourceIds changes the signature.
test("changing selectedSourceIds changes the signature", () => {
  const before = sig(base());
  const s = base();
  s.selectedSourceIds = ["src_a", "src_b"];
  assert.notEqual(sig(s), before);
});

// 6. Changing selectedClipId changes the signature.
test("changing selectedClipId changes the signature", () => {
  const before = sig(base());
  const s = base();
  s.selectedClipId = null;
  assert.notEqual(sig(s), before);
});

// 7. Changing boundaryTransitions changes the signature.
test("changing boundaryTransitions changes the signature", () => {
  const before = sig(base());
  const s = base();
  s.boundaryTransitions = [
    { index: 1, type: "crossfade", mode: "manual", durationSeconds: 0.5 }
  ];
  assert.notEqual(sig(s), before);
});

// 8. Changing pendingExecution changes the signature.
test("changing pendingExecution changes the signature", () => {
  const before = sig(base());
  const s = base();
  s.pendingExecution = true;
  assert.notEqual(sig(s), before);
});

// 9. Changing ONLY progress does NOT change the signature.
test("changing only progress does NOT change the signature", () => {
  const before = sig(base());
  const s = base();
  s.progress = 0.73;
  assert.equal(sig(s), before);
});

// Extra durable fields the editor must persist on change ----------------
test("changing the plan changes the signature", () => {
  const before = sig(base());
  const s = base();
  s.plan = { ...plan(), targetShortSeconds: 45 };
  assert.notEqual(sig(s), before);
});

test("changing pendingTimelineOp changes the signature", () => {
  const before = sig(base());
  const s = base();
  s.pendingTimelineOp = "append";
  assert.notEqual(sig(s), before);
});

test("changing mode changes the signature", () => {
  const before = sig(base());
  const s = base();
  s.mode = "compose";
  assert.notEqual(sig(s), before);
});

test("changing userTier changes the signature", () => {
  const before = sig(base());
  const s = base();
  s.userTier = "advanced";
  assert.notEqual(sig(s), before);
});

test("changing inferred chips changes the signature", () => {
  const before = sig(base());
  const s = base();
  s.inferred = [{ field: "targetShortSeconds", value: 30, reason: "TikTok" }];
  assert.notEqual(sig(s), before);
});

test("changing lastBriefing changes the signature", () => {
  const before = sig(base());
  const s = base();
  s.lastBriefing = { id: "b2", sourceId: "src_a", bestParts: [{}, {}, {}] };
  assert.notEqual(sig(s), before);
});

test("appending a message changes the signature", () => {
  const before = sig(base());
  const s = base();
  s.messages = [
    ...s.messages,
    { id: "m2", role: "assistant", content: "ok", timestamp: 2 }
  ];
  assert.notEqual(sig(s), before);
});

test("changing memory changes the signature", () => {
  const before = sig(base());
  const s = base();
  s.memory = { styles: ["cinematic"], keep: [], skip: [] };
  assert.notEqual(sig(s), before);
});

test("changing title changes the signature", () => {
  const before = sig(base());
  const s = base();
  s.title = "Renamed";
  assert.notEqual(sig(s), before);
});

test("changing status changes the signature", () => {
  const before = sig(base());
  const s = base();
  s.status = "completed";
  assert.notEqual(sig(s), before);
});

// Editing a highlight's range (not just count) changes the signature.
test("editing a highlight range changes the signature", () => {
  const before = sig(base());
  const s = base();
  s.highlights = [{ id: "c1", start: 0, end: 8, score: 1, reason: "", sourceId: "src_a" }];
  assert.notEqual(sig(s), before);
});

// restoreSession-style transition (new session id + placeholders) changes it.
test("a restore-style state (new session + placeholders) changes the signature", () => {
  const before = sig(base());
  const s = base();
  s.sessionId = "sess_restored";
  s.sources = [];
  s.missingSources = [
    { id: "src_a", hash: "h_a" },
    { id: "src_b", hash: "h_b" }
  ];
  s.activeSourceId = "src_a";
  assert.notEqual(sig(s), before);
});

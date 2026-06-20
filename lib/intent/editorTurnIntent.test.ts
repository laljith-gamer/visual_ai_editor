import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyEditorTurn, type EditorTurnContext } from "./editorTurnIntent.ts";

const ctx = (over: Partial<EditorTurnContext> = {}): EditorTurnContext => ({
  hasTimeline: false,
  clipCount: 0,
  hasPendingAction: false,
  sourceCount: 1,
  priorTargetSeconds: null,
  ...over
});

test("'find a specific moment' with no subject → clarify, not search", () => {
  const r = classifyEditorTurn("Find a specific moment", ctx());
  assert.equal(r.kind, "clarify_missing_specific_moment");
  assert.ok(r.shouldAsk);
});

test("a concrete moment search is passthrough (planner handles it)", () => {
  const r = classifyEditorTurn("find the moment where he scores the goal", ctx({ hasTimeline: true, clipCount: 3 }));
  assert.equal(r.kind, "passthrough");
});

test("remove + only fighting → refine_timeline (filter), asks first", () => {
  const r = classifyEditorTurn("remove cutscene i need only fighting scene", ctx({ hasTimeline: true, clipCount: 13 }));
  assert.equal(r.kind, "refine_timeline");
  assert.equal(r.refinementKind, "filter");
  assert.ok(r.exclude.includes("cutscene"));
  assert.ok(r.include.includes("fighting"));
  assert.ok(r.shouldAsk);
});

test("'remove all boring parts make video for 1 min' → refine + target 60", () => {
  const r = classifyEditorTurn("remove all clips boring parts make video for 1 min", ctx({ hasTimeline: true, clipCount: 13, priorTargetSeconds: 120 }));
  assert.equal(r.kind, "refine_timeline");
  assert.ok(r.exclude.includes("boring"));
  assert.equal(r.latestDurationSeconds, 60);
  assert.equal(r.durationChanged, true);
});

test("'trim to fit' → trim_to_target, preserves prior target", () => {
  const r = classifyEditorTurn("trim to fit", ctx({ hasTimeline: true, clipCount: 18, priorTargetSeconds: 60 }));
  assert.equal(r.kind, "trim_to_target");
  assert.equal(r.latestDurationSeconds, 60);
});

test("pending action + affirm → confirm_pending", () => {
  const r = classifyEditorTurn("Yes, do it", ctx({ hasPendingAction: true }));
  assert.equal(r.kind, "confirm_pending");
});

test("pending action + cancel → cancel_pending", () => {
  const r = classifyEditorTurn("no thanks", ctx({ hasPendingAction: true }));
  assert.equal(r.kind, "cancel_pending");
});

test("'from current video clips' resolves scope (pending) and keeps target", () => {
  const r = classifyEditorTurn("from current video clips", ctx({ hasTimeline: true, hasPendingAction: true, priorTargetSeconds: 60 }));
  assert.equal(r.kind, "scope_resolution");
  assert.equal(r.scope, "current_video");
  assert.equal(r.latestDurationSeconds, 60);
});

test("latest explicit duration wins on a passthrough creation turn", () => {
  const r = classifyEditorTurn("give me red boy and wukong fight best combat scene for 2 min", ctx({ priorTargetSeconds: null }));
  assert.equal(r.kind, "passthrough");
  assert.equal(r.latestDurationSeconds, 120);
});

test("'yes do it' with NOTHING pending → confirm_pending (router answers honestly, never a search)", () => {
  const r = classifyEditorTurn("yes do it", ctx({ hasPendingAction: false }));
  assert.equal(r.kind, "confirm_pending");
});

test("'yes' is NOT hijacked when a planner run / clarify is parked", () => {
  const r = classifyEditorTurn("yes", ctx({ hasPendingAction: false, hasPendingExecution: true }));
  assert.equal(r.kind, "passthrough");
});

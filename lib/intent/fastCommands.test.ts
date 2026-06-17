import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFastCommand, decideFastAction, type FastActionState } from "./fastCommands.ts";

test("affirmations classify as affirm (never planner)", () => {
  for (const t of ["yes", "yes do it", "go ahead", "ok do it", "sure", "do it", "run it", "proceed"]) {
    assert.equal(classifyFastCommand(t)?.kind, "affirm", `"${t}"`);
  }
});

test("declines/cancels classify as cancel", () => {
  for (const t of ["no", "nope", "cancel", "stop", "never mind", "forget it"]) {
    assert.equal(classifyFastCommand(t)?.kind, "cancel", `"${t}"`);
  }
});

test("undo and redo classify distinctly (undo is not cancel)", () => {
  for (const t of ["undo", "undo that", "revert", "go back", "put it back"]) {
    assert.equal(classifyFastCommand(t)?.kind, "undo", `"${t}"`);
  }
  for (const t of ["redo", "redo that", "reapply"]) {
    assert.equal(classifyFastCommand(t)?.kind, "redo", `"${t}"`);
  }
});

test("render classifies as render (assemble)", () => {
  for (const t of ["render", "render it", "render the video", "finish", "assemble"]) {
    assert.equal(classifyFastCommand(t)?.kind, "render", `"${t}"`);
  }
});

test("export/download classify as export (distinct from render)", () => {
  for (const t of ["export", "export it", "export the video", "download", "download it", "save the video"]) {
    assert.equal(classifyFastCommand(t)?.kind, "export", `"${t}"`);
  }
});

test("partial/edit commands are NOT fast commands (flow to parser)", () => {
  for (const t of [
    "add first 5 seconds",
    "remove clip 1",
    "move clip 1 after clip 2",
    "go to clip 2",
    "render the part where he scores",
    "export the funny bit",
    "add the part where he says yes",
    "pick best parts"
  ]) {
    assert.equal(classifyFastCommand(t), null, `"${t}" should not be a fast command`);
  }
});

test("empty / long input returns null", () => {
  assert.equal(classifyFastCommand(""), null);
  assert.equal(classifyFastCommand("yes please go ahead and do the whole thing now"), null);
});

// ---- decideFastAction (pure routing decision) ----------------------

const state = (over: Partial<FastActionState> = {}): FastActionState => ({
  pendingExecution: false,
  pendingClarify: false,
  highlightCount: 0,
  hasRenderedBlob: false,
  ...over
});

test("undo/redo always route to the store (never planner)", () => {
  assert.equal(decideFastAction("undo", state({ highlightCount: 3 })), "undo");
  assert.equal(decideFastAction("redo", state()), "redo");
});

test("render uses real render when clips exist, asks to add when empty", () => {
  assert.equal(decideFastAction("render", state({ highlightCount: 2 })), "render");
  assert.equal(decideFastAction("render", state({ highlightCount: 0 })), "render_empty");
});

test("export downloads when a rendered blob exists, else render-first", () => {
  assert.equal(decideFastAction("export", state({ hasRenderedBlob: true })), "export");
  assert.equal(decideFastAction("export", state({ hasRenderedBlob: false })), "export_no_render");
});

test("affirm/cancel delegate to the existing gate only when something is pending", () => {
  assert.equal(decideFastAction("affirm", state({ pendingExecution: true })), "delegate");
  assert.equal(decideFastAction("affirm", state({ pendingClarify: true })), "delegate");
  assert.equal(decideFastAction("affirm", state()), "nudge_affirm");
  assert.equal(decideFastAction("cancel", state({ pendingExecution: true })), "delegate");
  assert.equal(decideFastAction("cancel", state()), "nudge_cancel");
});


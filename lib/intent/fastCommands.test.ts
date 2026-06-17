import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFastCommand } from "./fastCommands.ts";

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

test("render/export classify as render", () => {
  for (const t of ["render", "export", "render it", "export the video", "finish"]) {
    assert.equal(classifyFastCommand(t)?.kind, "render", `"${t}"`);
  }
});

test("partial/edit commands are NOT fast commands (flow to parser)", () => {
  for (const t of [
    "add first 5 seconds",
    "remove clip 1",
    "move clip 1 after clip 2",
    "go to clip 2",
    "render the part where he scores",
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

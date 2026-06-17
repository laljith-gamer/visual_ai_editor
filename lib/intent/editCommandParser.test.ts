import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEditCommand } from "./editCommandParser.ts";

test("add first 2 min from video 2 after clip 3", () => {
  const r = parseEditCommand("add first 2 min from video 2 after clip 3");
  assert.equal(r.command?.op, "add_range");
  if (r.command?.op === "add_range") {
    assert.equal(r.command.sourceRef?.kind, "index");
    assert.equal((r.command.sourceRef as { index: number }).index, 1);
    assert.equal(r.command.range.kind, "first_amount");
    assert.equal(r.command.placement?.kind, "after_clip");
  }
});

test("remove clip 2", () => {
  const r = parseEditCommand("remove clip 2");
  assert.equal(r.command?.op, "remove_clip");
  if (r.command?.op === "remove_clip") {
    assert.equal((r.command.clipRef as { index: number }).index, 1);
  }
});

test("replace clip 1 with best goal from video 2", () => {
  const r = parseEditCommand("replace clip 1 with best goal from video 2");
  assert.equal(r.command?.op, "replace_clip");
  if (r.command?.op === "replace_clip") {
    assert.equal((r.command.target as { index: number }).index, 0);
    assert.equal(r.command.replacement.kind, "concept");
    if (r.command.replacement.kind === "concept") {
      assert.equal(r.command.replacement.sourceRef?.kind, "index");
      assert.match(r.command.replacement.concept, /goal/);
    }
  }
});

test("move clip 3 before clip 1", () => {
  const r = parseEditCommand("move clip 3 before clip 1");
  assert.equal(r.command?.op, "move_clip");
  if (r.command?.op === "move_clip") {
    assert.equal((r.command.clipRef as { index: number }).index, 2);
    assert.equal(r.command.placement.kind, "before_clip");
  }
});

test("add the part where he says subscribe → concept", () => {
  const r = parseEditCommand("add the part where he says subscribe");
  assert.equal(r.command?.op, "add_concept");
  if (r.command?.op === "add_concept") {
    assert.match(r.command.concept, /subscribe/);
  }
});

test("more like clip 3 → no structured command (reinforcement)", () => {
  const r = parseEditCommand("more like clip 3");
  assert.equal(r.command, null);
});

test("avoid intro → no structured command", () => {
  const r = parseEditCommand("avoid intro");
  assert.equal(r.command, null);
});

test("render → render command", () => {
  const r = parseEditCommand("render it");
  assert.equal(r.command?.op, "render");
});

test("add clip 2 after clip 5 → add_clip_ref", () => {
  const r = parseEditCommand("add clip 2 after clip 5");
  assert.equal(r.command?.op, "add_clip_ref");
});

test("non-command falls through to null", () => {
  const r = parseEditCommand("make it cinematic and dramatic");
  assert.equal(r.command, null);
});

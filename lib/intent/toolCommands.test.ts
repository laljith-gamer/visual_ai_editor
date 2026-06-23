// Tests for the deterministic tool-command parsers (format + source control).

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseFormatCommand, parseSourceControlCommand } from "./toolCommands.ts";

// ---- FORMAT / aspect -------------------------------------------------
test("format: standalone directives map correctly", () => {
  assert.equal(parseFormatCommand("make it vertical")?.format, "vertical");
  assert.equal(parseFormatCommand("change to horizontal")?.format, "horizontal");
  assert.equal(parseFormatCommand("switch to square")?.format, "square");
  assert.equal(parseFormatCommand("9:16")?.format, "vertical");
  assert.equal(parseFormatCommand("make it 16:9")?.format, "horizontal");
  assert.equal(parseFormatCommand("1:1")?.format, "square");
  assert.equal(parseFormatCommand("portrait please")?.format, "vertical");
  assert.equal(parseFormatCommand("landscape")?.format, "horizontal");
  assert.equal(parseFormatCommand("make the output vertical now")?.format, "vertical");
});

test("format: does NOT fire on a CREATE request that merely names a format", () => {
  assert.equal(parseFormatCommand("make a vertical reel of the fight"), null);
  assert.equal(parseFormatCommand("vertical reel of cooking for 30s"), null);
  assert.equal(parseFormatCommand("what is a vertical video"), null);
});

// ---- SOURCE control --------------------------------------------------
test("source: select-all / active-only", () => {
  assert.equal(parseSourceControlCommand("use all videos")?.kind, "select_all_sources");
  assert.equal(parseSourceControlCommand("all videos")?.kind, "select_all_sources");
  assert.equal(parseSourceControlCommand("active only video")?.kind, "select_active_only");
  assert.equal(parseSourceControlCommand("only this video for ai")?.kind, "select_active_only");
});

test("source: use only / include a specific video by index", () => {
  const only = parseSourceControlCommand("use only video 2");
  assert.equal(only?.kind, "select_only");
  assert.equal(only && only.kind === "select_only" && only.ref.kind === "index" ? only.ref.index : -1, 1);

  const inc = parseSourceControlCommand("also use video 1");
  assert.equal(inc?.kind, "select_include");

  const ord = parseSourceControlCommand("use only the second video");
  assert.equal(ord?.kind, "select_only");
});

test("source: switch the active/preview source", () => {
  assert.equal(parseSourceControlCommand("switch to video 2")?.kind, "switch_active");
  assert.equal(parseSourceControlCommand("show video 1")?.kind, "switch_active");
  assert.equal(parseSourceControlCommand("open the third video")?.kind, "switch_active");
});

test("source: ignores plain content / edit requests", () => {
  assert.equal(parseSourceControlCommand("make a 30s reel of the fight"), null);
  assert.equal(parseSourceControlCommand("trim the first 5 seconds"), null);
  assert.equal(parseSourceControlCommand("hi"), null);
});

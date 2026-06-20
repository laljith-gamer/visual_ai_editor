// Tests for the overlap-resolution intent parser.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseOverlapResolution } from "./overlapIntent.ts";

test("keep both", () => {
  assert.equal(parseOverlapResolution("keep both"), "keep_both");
  assert.equal(parseOverlapResolution("Keep both clips please"), "keep_both");
});

test("replace old", () => {
  assert.equal(parseOverlapResolution("replace the old clip"), "replace_existing");
  assert.equal(parseOverlapResolution("use the new one instead"), "replace_existing");
});

test("trim overlap", () => {
  assert.equal(parseOverlapResolution("trim the overlap"), "trim_new");
  assert.equal(parseOverlapResolution("trim to non-overlap"), "trim_new");
});

test("skip new", () => {
  assert.equal(parseOverlapResolution("skip the new clip"), "skip_new");
  assert.equal(parseOverlapResolution("keep the old one only"), "skip_new");
});

test("ambiguous → null (caller asks)", () => {
  assert.equal(parseOverlapResolution("hmm not sure"), null);
  assert.equal(parseOverlapResolution(""), null);
});

test("keep both wins over the generic keep-old skip", () => {
  assert.equal(parseOverlapResolution("just keep both, don't replace anything"), "keep_both");
});

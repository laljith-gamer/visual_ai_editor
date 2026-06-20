import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveActiveTarget,
  isTrimToFitPhrase,
  isDurationOnlyInstruction
} from "./targetDurationMemory.ts";

test("latest explicit duration wins over prior", () => {
  const a = resolveActiveTarget(null, "give me the fight scene for 2 min");
  assert.equal(a.seconds, 120);
  assert.equal(a.changed, true);
  const b = resolveActiveTarget(a.seconds, "remove boring parts make video for 1 min");
  assert.equal(b.seconds, 60);
  assert.equal(b.changed, true);
});

test("turn with no duration preserves prior target", () => {
  const r = resolveActiveTarget(60, "trim to fit");
  assert.equal(r.seconds, 60);
  assert.equal(r.changed, false);
});

test("trim to fit is detected", () => {
  assert.equal(isTrimToFitPhrase("trim to fit"), true);
  assert.equal(isTrimToFitPhrase("make it fit the target"), true);
  assert.equal(isTrimToFitPhrase("give me combat for 2 min"), false);
});

test("duration-only instructions detected", () => {
  assert.equal(isDurationOnlyInstruction("1 min"), true);
  assert.equal(isDurationOnlyInstruction("make it 30 seconds"), true);
  assert.equal(isDurationOnlyInstruction("trim to fit"), true);
  assert.equal(isDurationOnlyInstruction("1:30"), true);
});

test("a content request is NOT duration-only", () => {
  assert.equal(isDurationOnlyInstruction("give me the wukong fight for 1 min"), false);
});

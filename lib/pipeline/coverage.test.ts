// Tests for target-coverage assessment (issue #62).
//
// Run with Node's built-in runner + --experimental-strip-types. The module
// under test only imports config constants (relative path).

import { test } from "node:test";
import assert from "node:assert/strict";
import { assessTargetCoverage, buildUnderfillMessage } from "./coverage.ts";

test("explicit 40s target with a single 1s clip → review, no 'Tap Render'", () => {
  const a = assessTargetCoverage({
    userSpecifiedDuration: true,
    targetSeconds: 40,
    selectedSeconds: 1,
    clipCount: 1,
    weakOnly: true,
    scoreMax: 0.35
  });
  assert.equal(a.level, "review");
  assert.ok(a.message && a.message.length > 0);
  assert.ok(!/tap\s+render/i.test(a.message ?? ""), a.message);
  assert.ok(!/ready to render/i.test(a.message ?? ""), a.message);
  assert.ok(/40s/.test(a.message ?? ""), a.message);
});

test("explicit 40s target filled to ~38s → ok (ready allowed)", () => {
  const a = assessTargetCoverage({
    userSpecifiedDuration: true,
    targetSeconds: 40,
    selectedSeconds: 38.5,
    clipCount: 5,
    weakOnly: true,
    scoreMax: 0.34
  });
  assert.equal(a.level, "ok");
});

test("weak confidence + below-half coverage → review", () => {
  const a = assessTargetCoverage({
    userSpecifiedDuration: true,
    targetSeconds: 40,
    selectedSeconds: 16, // 0.4 ratio
    clipCount: 2,
    weakOnly: true,
    scoreMax: 0.3
  });
  assert.equal(a.level, "review");
});

test("strong confidence at 0.4 ratio → ok (not a hard underfill, not weak)", () => {
  const a = assessTargetCoverage({
    userSpecifiedDuration: true,
    targetSeconds: 40,
    selectedSeconds: 16, // 0.4 ratio, but strong
    clipCount: 2,
    weakOnly: false,
    scoreMax: 0.8
  });
  assert.equal(a.level, "ok");
});

test("no explicit duration → always ok (quality-floor path unchanged)", () => {
  const a = assessTargetCoverage({
    userSpecifiedDuration: false,
    targetSeconds: 0,
    selectedSeconds: 1,
    clipCount: 1,
    weakOnly: true,
    scoreMax: 0.2
  });
  assert.equal(a.level, "ok");
  assert.equal(a.ratio, 1);
});

test("underfill message states found and target seconds, offers broader reel", () => {
  const msg = buildUnderfillMessage({
    userSpecifiedDuration: true,
    targetSeconds: 40,
    selectedSeconds: 1,
    clipCount: 1,
    weakOnly: true,
    scoreMax: 0.35
  });
  assert.ok(msg.includes("1s"), msg);
  assert.ok(msg.includes("40s"), msg);
  assert.ok(/broader/i.test(msg), msg);
});

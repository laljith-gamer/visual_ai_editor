// Regression tests for the deterministic actionable-intent interpreter.
//
// Run with:  npm run test:intent
// (uses Node's built-in test runner + --experimental-strip-types, so no test
//  framework dependency is added. deriveIntent.ts is import-free on purpose.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveActionableIntent, actionableIntentMessage } from "./deriveIntent.ts";

const STATIC_FALLBACK = "what should the short be about";

test("ingredient-only for 1min → actionable plan, 60s, exclusive", () => {
  const i = deriveActionableIntent("i need a ingredient part alone for 1min", {
    hasVideo: true
  });
  assert.equal(i.actionable, true);
  assert.equal(i.targetSeconds, 60);
  assert.equal(i.userSpecifiedDuration, true);
  assert.equal(i.exclusiveOnly, true);
  assert.equal(i.rawFocus, "ingredient");
  assert.equal(i.focus, "ingredient-only moments");
  assert.deepEqual(i.scenarioLabels, ["ingredient-only moments"]);
  assert.deepEqual(i.negativeConstraints, [
    "keep only the ingredient segments",
    "exclude unrelated scenes"
  ]);
  assert.equal(i.format, "vertical");
  assert.equal(i.needsAnalysis, true);
});

test("ingredient-only with no video → upload-first message, no static fallback", () => {
  const i = deriveActionableIntent("i need a ingredient part alone for 1min", {
    hasVideo: false
  });
  assert.equal(i.actionable, true);
  const msg = actionableIntentMessage(i, false);
  assert.ok(msg.toLowerCase().startsWith("upload the video first"), msg);
  assert.ok(!msg.toLowerCase().includes(STATIC_FALLBACK), msg);
});

test("ingredient-only with video → confirm message mentions 60s short", () => {
  const i = deriveActionableIntent("i need a ingredient part alone for 1min", {
    hasVideo: true
  });
  const msg = actionableIntentMessage(i, true);
  assert.ok(msg.includes("60s short"), msg);
  assert.ok(!msg.toLowerCase().includes(STATIC_FALLBACK), msg);
});

test("broken 'see what he cooking and catch ingrdient' → typo fixed, clean labels", () => {
  const i = deriveActionableIntent("see what he cooking and catch ingrdient", {
    hasVideo: true
  });
  assert.equal(i.actionable, true);
  assert.equal(i.exclusiveOnly, false);
  assert.equal(i.targetSeconds, null);
  assert.equal(i.userSpecifiedDuration, false);
  // typo normalized: no "ingrdient" anywhere
  assert.ok(!i.rawFocus?.includes("ingrdient"), i.rawFocus ?? "");
  assert.equal(i.rawFocus, "cooking ingredient");
  assert.equal(i.focus, "cooking and ingredient moments");
  assert.deepEqual(i.scenarioLabels, ["cooking moments", "ingredient moments"]);
  // never echoes the raw broken phrase as a scenario label
  for (const label of i.scenarioLabels) {
    assert.ok(!label.includes("ingrdient"), label);
    assert.ok(!label.includes("see what"), label);
  }
});

test("'make it funny' → actionable funny moments", () => {
  const i = deriveActionableIntent("make it funny", { hasVideo: true });
  assert.equal(i.actionable, true);
  assert.equal(i.rawFocus, "funny");
  assert.equal(i.focus, "funny moments");
});

test("duration parsing variants", () => {
  assert.equal(deriveActionableIntent("only ingredients 1 min").targetSeconds, 60);
  assert.equal(deriveActionableIntent("make 30 sec intro only").targetSeconds, 30);
  assert.equal(deriveActionableIntent("one minute cooking").targetSeconds, 60);
  assert.equal(deriveActionableIntent("from 0:30 to 1:30 funny").targetSeconds, 30); // first clock match
});

test("truly empty / no-focus input is not actionable", () => {
  const i = deriveActionableIntent("make a short", { hasVideo: true });
  assert.equal(i.actionable, false);
  assert.equal(i.rawFocus, null);
});

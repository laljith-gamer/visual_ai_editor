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


test("multi-source/compose words never become scenario labels (v1.8.1 stopwords)", () => {
  // Even if a multi-source prompt slips through to the generic fallback, the
  // labels must not contain pick/first/second/transition/video/upload.
  const i = deriveActionableIntent(
    "pick combat in the first video and the cutscene in the second and make it transition",
    { hasVideo: true }
  );
  const banned = ["pick", "first", "second", "third", "transition", "video", "upload", "make"];
  for (const label of i.scenarioLabels) {
    for (const b of banned) {
      assert.ok(
        !label.split(/\s+/).includes(b),
        `scenario label "${label}" leaked banned word "${b}"`
      );
    }
  }
});


// ---------------------------------------------------------------------
// Issue #62 — generic best-parts intent. Generic editing/output vocabulary
// ("best", "picks", "highlights", "make a reel") must NOT become literal
// search subjects. The duration is preserved.
// ---------------------------------------------------------------------

test("'make a best picks for reels for 40 sec' → generic best-parts, 40s, no 'best'/'picks' subjects", () => {
  const i = deriveActionableIntent("make a best picks for reels for 40 sec", {
    hasVideo: true
  });
  assert.equal(i.actionable, true);
  assert.equal(i.genericBestParts, true);
  assert.equal(i.targetSeconds, 40);
  assert.equal(i.userSpecifiedDuration, true);
  assert.equal(i.focus, "best moments");
  assert.equal(i.rawFocus, "visual interest");
  assert.deepEqual(i.scenarioLabels, ["visually rich moments"]);
  // The bug: "best" and "picks" became separate search subjects.
  for (const label of i.scenarioLabels) {
    const words = label.split(/\s+/);
    assert.ok(!words.includes("best"), `leaked "best" in "${label}"`);
    assert.ok(!words.includes("picks"), `leaked "picks" in "${label}"`);
  }
  // The confirm message must not promise "best and picks moments".
  const msg = actionableIntentMessage(i, true);
  assert.ok(!msg.toLowerCase().includes("picks"), msg);
  assert.ok(!/best and|and picks/i.test(msg), msg);
});

test("'make a 40 sec reel' → generic best-parts with preserved 40s target", () => {
  const i = deriveActionableIntent("make a 40 sec reel", { hasVideo: true });
  assert.equal(i.actionable, true);
  assert.equal(i.genericBestParts, true);
  assert.equal(i.targetSeconds, 40);
  assert.equal(i.userSpecifiedDuration, true);
  assert.deepEqual(i.scenarioLabels, ["visually rich moments"]);
});

test("'highlights' / 'best parts' → generic best-parts even without a duration", () => {
  for (const phrase of ["highlights", "give me the best parts", "top moments"]) {
    const i = deriveActionableIntent(phrase, { hasVideo: true });
    assert.equal(i.genericBestParts, true, phrase);
    assert.equal(i.actionable, true, phrase);
    assert.deepEqual(i.scenarioLabels, ["visually rich moments"], phrase);
  }
});

test("a concrete subject next to 'best' stays subject-driven (NOT generic)", () => {
  const i = deriveActionableIntent("best cooking moments for 40 sec", {
    hasVideo: true
  });
  assert.equal(i.genericBestParts, false);
  assert.equal(i.targetSeconds, 40);
  assert.equal(i.focus, "cooking moments");
  assert.deepEqual(i.scenarioLabels, ["cooking moments"]);
});

test("'make a short' (no duration, no best word) stays non-actionable", () => {
  const i = deriveActionableIntent("make a short", { hasVideo: true });
  assert.equal(i.actionable, false);
  assert.equal(i.genericBestParts, false);
});

test("'duration' is a meta word, never a subject ('fighting alone' → fighting-only)", () => {
  const i = deriveActionableIntent(
    "pick best parts from this duration 2 min of fighting alone",
    { hasVideo: true }
  );
  assert.equal(i.actionable, true);
  assert.equal(i.exclusiveOnly, true);
  assert.equal(i.targetSeconds, 120);
  assert.equal(i.userSpecifiedDuration, true);
  assert.equal(i.rawFocus, "fighting");
  assert.equal(i.focus, "fighting-only moments");
  assert.deepEqual(i.scenarioLabels, ["fighting-only moments"]);
  // The bug: "duration" leaked into the scenario ("duration fighting-only").
  for (const label of i.scenarioLabels) {
    assert.ok(!label.includes("duration"), `leaked "duration" in "${label}"`);
  }
});


// ---------------------------------------------------------------------
// Intensity / filler / conversational-meta cleanup. Quality descriptors
// ("intense", "amazing"), fillers ("again"), and follow-up words ("more",
// "detailed") must NEVER survive as literal search subjects — that was the
// "look for fight and again and red and boy and intensly and amaing combat
// moments" keyword-soup bug.
// ---------------------------------------------------------------------

test("messy fight request drops intensifiers/fillers, keeps real subjects", () => {
  const i = deriveActionableIntent(
    "find best moment where her fight again red boy intensly and amaing combats",
    { hasVideo: true }
  );
  assert.equal(i.actionable, true);
  assert.equal(i.genericBestParts, false);

  const banned = [
    "best", "again", "intensly", "intensely", "amaing", "amazing", "moment",
    "where", "find", "her"
  ];
  for (const label of i.scenarioLabels) {
    for (const b of banned) {
      assert.ok(
        !label.split(/\s+/).includes(b),
        `scenario label "${label}" leaked non-subject word "${b}"`
      );
    }
  }
  // Real subjects survive.
  assert.ok(i.rawFocus?.includes("fight"), i.rawFocus ?? "");

  // The confirm message must not promise the junk-word soup.
  const msg = actionableIntentMessage(i, true);
  assert.ok(!/again|intensly|amaing|amazing/i.test(msg), msg);
});

test("'intense amazing combat' → single 'combat' subject, no intensifier leak", () => {
  const i = deriveActionableIntent("intense amazing combat", { hasVideo: true });
  assert.equal(i.actionable, true);
  assert.equal(i.genericBestParts, false);
  assert.equal(i.rawFocus, "combat");
  assert.equal(i.focus, "combat moments");
  assert.deepEqual(i.scenarioLabels, ["combat moments"]);
});

test("bare follow-up 'more detailed' is NOT a new search", () => {
  const i = deriveActionableIntent("more detailed", { hasVideo: true });
  assert.equal(i.actionable, false);
  assert.equal(i.genericBestParts, false);
  assert.equal(i.rawFocus, null);
  assert.equal(i.focus, null);
  assert.deepEqual(i.scenarioLabels, []);
  const msg = actionableIntentMessage(i, true);
  assert.ok(!/more|detailed/i.test(msg), msg);
});

test("'explain why you picked these' is a follow-up, not a search", () => {
  const i = deriveActionableIntent("explain why you picked these", {
    hasVideo: true
  });
  assert.equal(i.actionable, false);
  assert.equal(i.rawFocus, null);
});

test("'make it epic and intense' → generic best-parts (quality-only ask)", () => {
  const i = deriveActionableIntent("make it epic and intense", { hasVideo: true });
  assert.equal(i.genericBestParts, true);
  assert.equal(i.actionable, true);
  assert.deepEqual(i.scenarioLabels, ["visually rich moments"]);
});

test("intensifier next to a real subject keeps the subject ('amazing cooking')", () => {
  const i = deriveActionableIntent("amazing cooking parts", { hasVideo: true });
  assert.equal(i.genericBestParts, false);
  assert.equal(i.rawFocus, "cooking");
  assert.equal(i.focus, "cooking moments");
});


test("analysis/confidence reply is not turned into content subjects (safety net)", () => {
  // Primary routing for this is detectQuickScanCommand (→ deeper scan), but if
  // it ever reaches the interpreter it must NOT become "ok and analys and high
  // and confidence moments".
  const i = deriveActionableIntent("ok analys for high confidence", {
    hasVideo: true
  });
  const banned = ["ok", "analys", "analyse", "analyze", "confidence", "scan"];
  for (const label of i.scenarioLabels) {
    for (const b of banned) {
      assert.ok(
        !label.split(/\s+/).includes(b),
        `scenario label "${label}" leaked meta word "${b}"`
      );
    }
  }
  const msg = actionableIntentMessage(i, true);
  assert.ok(!/analys|confidence/i.test(msg), msg);
});


test("'then create' never becomes a 'then' search (continuation safety net)", () => {
  const i = deriveActionableIntent("then create", { hasVideo: true });
  for (const label of i.scenarioLabels) {
    assert.ok(!label.split(/\s+/).includes("then"), `leaked "then" in "${label}"`);
  }
  const msg = actionableIntentMessage(i, true);
  assert.ok(!/\bthen\b/i.test(msg), msg);
});


test("multi-word title stays ONE phrase, not per-word soup", () => {
  const i = deriveActionableIntent(
    "this is black myth wukong tiger vanguard fight make a best combat and starting and ending of fighting and best moment in it make a shorts for 1 min",
    { hasVideo: true }
  );
  assert.equal(i.actionable, true);
  assert.equal(i.targetSeconds, 60);
  // The game title is kept together as one scenario.
  assert.ok(
    i.scenarioLabels.some((l) => l.includes("black myth wukong")),
    JSON.stringify(i.scenarioLabels)
  );
  // It must NOT explode into one search per word.
  for (const bad of ["black moments", "myth moments", "wukong moments", "tiger moments"]) {
    assert.ok(
      !i.scenarioLabels.includes(bad),
      `soup label "${bad}" in ${JSON.stringify(i.scenarioLabels)}`
    );
  }
});

test("adjacent content words group into phrases ('red boy', 'wukong fight')", () => {
  const i = deriveActionableIntent("red boy and wukong fight best combat scene", {
    hasVideo: true
  });
  assert.deepEqual(i.scenarioLabels, [
    "red boy moments",
    "wukong fight moments",
    "combat moments"
  ]);
});

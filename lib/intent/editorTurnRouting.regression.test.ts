// =====================================================================
// Regression tests derived from a REAL failing refinement conversation.
//
// These assert GENERIC editor-first routing behavior (not exact hardcoded
// phrases): refinement/control turns must route as editor operations, never
// as random visual searches. The conversation is used only as a source of
// realistic turns; the assertions are about intent KINDS + extracted slots.
// =====================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyEditorTurn, type EditorTurnContext } from "./editorTurnIntent.ts";
import { extractTopicPhrases } from "./topicPhrases.ts";
import { detectRefinement } from "./refinementIntent.ts";

const ctx = (over: Partial<EditorTurnContext> = {}): EditorTurnContext => ({
  hasTimeline: false,
  clipCount: 0,
  hasPendingAction: false,
  sourceCount: 1,
  priorTargetSeconds: null,
  ...over
});

// 1) "Find a specific moment" with no subject → ask, do NOT build a short.
test("regression 1: vague 'find a specific moment' asks instead of searching", () => {
  const r = classifyEditorTurn("Find a specific moment", ctx({ hasTimeline: true, clipCount: 1 }));
  assert.equal(r.kind, "clarify_missing_specific_moment");
  assert.ok(r.shouldAsk);
});

// 2) Genuine search: typo normalized, content phrases preserved, target 120.
test("regression 2: 'red boy and wukong fight best combact scene for 2 min'", () => {
  const text = "give me red boy and wukong fight best combact scene for 2 min";
  const r = classifyEditorTurn(text, ctx({ hasTimeline: true, clipCount: 1, priorTargetSeconds: null }));
  assert.equal(r.kind, "passthrough"); // a real new search → planner handles it
  assert.equal(r.latestDurationSeconds, 120);
  assert.equal(r.durationChanged, true);

  const phrases = extractTopicPhrases("give me red boy and wukong fight best combat scene");
  // preserves meaningful phrases — NOT "red and boy and wukong and fight"
  assert.ok(phrases.includes("red boy"));
  assert.ok(phrases.includes("wukong fight"));
  assert.ok(!phrases.includes("red"));
  assert.ok(!phrases.includes("boy"));
});

// 4) "remove cutscene i need only fighting scene" → refinement, not search.
test("regression 4: 'remove cutscene i need only fighting scene' is a refinement", () => {
  const r = classifyEditorTurn("remove cutscene i need only fighting scene", ctx({ hasTimeline: true, clipCount: 13 }));
  assert.equal(r.kind, "refine_timeline");
  assert.equal(r.refinementKind, "filter");
  assert.ok(r.exclude.includes("cutscene"));
  assert.ok(r.include.includes("fighting"));
  assert.ok(r.shouldAsk); // ask before mutating
});

// 13) Typo tolerance in a refinement ("cutsecene" / "comabt").
test("regression 13: typos in a refinement normalize to editing vocabulary", () => {
  const r = detectRefinement("remove cutsecene i don't need it only comabt");
  assert.equal(r.kind, "filter");
  assert.ok(r.exclude.includes("cutscene"));
  assert.ok(r.include.includes("combat"));
});

// 6 + 7) "yes do it" resolves a pending action; with nothing pending it is
//        answered honestly by the router — it must NEVER become a search.
test("regression 6/7: 'yes do it' confirms a pending action (never a search)", () => {
  const withPending = classifyEditorTurn("Yes, do it", ctx({ hasTimeline: true, hasPendingAction: true }));
  assert.equal(withPending.kind, "confirm_pending");

  // No pending action at all → still routed to confirm_pending, where the
  // router replies "I don't have a pending action" instead of searching.
  const noPending = classifyEditorTurn("yes do it", ctx({ hasTimeline: true, hasPendingAction: false }));
  assert.equal(noPending.kind, "confirm_pending");

  // But a parked planner run keeps "yes" for the existing run-plan flow.
  const planParked = classifyEditorTurn("yes", ctx({ hasPendingExecution: true }));
  assert.equal(planParked.kind, "passthrough");
});

// 9) "remove all clips boring parts make video for 1 min" → refine + 60s,
//    NOT a multi-source/compose ask.
test("regression 9: 'remove all boring parts ... 1 min' refines current timeline at 60s", () => {
  const r = classifyEditorTurn(
    "remove all clips boring parts make video for 1 min",
    ctx({ hasTimeline: true, clipCount: 13, priorTargetSeconds: 120 })
  );
  assert.equal(r.kind, "refine_timeline");
  assert.ok(r.exclude.includes("boring"));
  assert.equal(r.latestDurationSeconds, 60);
});

// 10) "from current video clips" resolves a pending scope, keeps target.
test("regression 10: 'from current video clips' resolves scope, preserves target", () => {
  const r = classifyEditorTurn(
    "from current video clips",
    ctx({ hasTimeline: true, hasPendingAction: true, priorTargetSeconds: 60 })
  );
  assert.equal(r.kind, "scope_resolution");
  assert.equal(r.scope, "current_video");
  assert.equal(r.latestDurationSeconds, 60);
  // never treated as a content search for "current"
  assert.equal(extractTopicPhrases("from current video clips").length, 0);
});

// 11) "trim to fit" → direct trim to the active target, no planner/search.
test("regression 11: 'trim to fit' is a direct trim to the active target", () => {
  const r = classifyEditorTurn("trim to fit", ctx({ hasTimeline: true, clipCount: 18, priorTargetSeconds: 60 }));
  assert.equal(r.kind, "trim_to_target");
  assert.equal(r.latestDurationSeconds, 60);
});

// 12) Latest explicit duration wins across turns (2 min → 1 min).
test("regression 12: latest explicit duration wins (120 then 60)", () => {
  const first = classifyEditorTurn("give me the fight for 2 min", ctx());
  assert.equal(first.latestDurationSeconds, 120);
  const second = classifyEditorTurn(
    "make video for 1 min",
    ctx({ hasTimeline: true, clipCount: 5, priorTargetSeconds: first.latestDurationSeconds })
  );
  assert.equal(second.latestDurationSeconds, 60);
});

// Full-conversation walk: NONE of the refinement/control turns may route to
// a raw visual search ("passthrough" is only acceptable for the genuine
// search turn #2).
test("regression: refinement/control turns never route to a raw search", () => {
  type Turn = { text: string; ctx: Partial<EditorTurnContext> };
  const turns: Array<{ t: Turn; expectNotSearch: boolean }> = [
    { t: { text: "Find a specific moment", ctx: { hasTimeline: true, clipCount: 1 } }, expectNotSearch: true },
    { t: { text: "remove cutscene i need only fighting scene", ctx: { hasTimeline: true, clipCount: 13 } }, expectNotSearch: true },
    { t: { text: "Yes, do it", ctx: { hasTimeline: true, hasPendingAction: true } }, expectNotSearch: true },
    { t: { text: "trim to fit", ctx: { hasTimeline: true, clipCount: 18, priorTargetSeconds: 60 } }, expectNotSearch: true }
  ];
  for (const { t, expectNotSearch } of turns) {
    const r = classifyEditorTurn(t.text, ctx(t.ctx));
    if (expectNotSearch) {
      assert.notEqual(r.kind, "passthrough", `"${t.text}" wrongly fell through to the planner`);
    }
  }
});


// 8) Conversational continuity: after we ask "Want me to search for fighting?"
//    (a pending action), "then create" / "create it" / "make it" CONFIRM that
//    action — they must NEVER become a "then"/"create" search.
test("regression 8: 'then create' confirms a pending action (not a search)", () => {
  for (const s of ["then create", "create it", "make it", "ok make it", "go ahead and make the reel", "now build it"]) {
    const r = classifyEditorTurn(s, ctx({ hasPendingAction: true }));
    assert.equal(r.kind, "confirm_pending", `${s} → ${r.kind}`);
  }
});

test("regression 8b: a build-continuation with a NEW topic is not a confirm", () => {
  // "create a cooking reel" introduces a fresh subject → let the planner take
  // it (passthrough), even if an action is pending.
  const r = classifyEditorTurn("create a cooking reel", ctx({ hasPendingAction: true }));
  assert.notEqual(r.kind, "confirm_pending");
});

test("regression 8c: 'make it 30 seconds' is a duration op, not a confirm", () => {
  const r = classifyEditorTurn("make it 30 seconds", ctx({ hasTimeline: true, clipCount: 2, hasPendingAction: true }));
  assert.notEqual(r.kind, "confirm_pending");
});


// 9) "not only X" / "not just X" must NOT be read as a keep-only refinement
//    (it means the opposite). It should fall through to the planner, not
//    turn the words into a content search.
test("regression 9: 'not only fixed center' is not a keep_only refinement", () => {
  const r = detectRefinement(
    "i need a 3 min short not only fixed center but dynamic based on scene"
  );
  assert.notEqual(r.kind, "keep_only");
  assert.notEqual(r.kind, "filter");

  const turn = classifyEditorTurn(
    "i need a 3 min short not only fixed center but dynamic based on scene",
    ctx()
  );
  assert.notEqual(turn.kind, "refine_timeline");
});

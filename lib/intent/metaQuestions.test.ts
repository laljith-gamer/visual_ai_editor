// Tests for the meta/explanation question guard. Run via the agentic test
// runner (node --test --experimental-strip-types + ts-ext hook).
//
// The guard must catch read-only explanation/reasoning/capability questions
// (so they're answered, never routed into a timeline mutation) AND must NOT
// hijack genuine edit commands.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMetaQuestion } from "./metaQuestions.ts";

// ---- positive: meta questions are detected ---------------------------
test("'explain why you did these changes' is meta (explain_previous_changes)", () => {
  const m = parseMetaQuestion("explain why you did these changes");
  assert.ok(m, "should be meta");
  assert.equal(m?.kind, "explain_previous_changes");
  assert.ok((m?.confidence ?? 0) >= 0.6);
});

test("'what did you change' is meta (what_changed)", () => {
  const m = parseMetaQuestion("what did you change");
  assert.equal(m?.kind, "what_changed");
});

test("'why did you add this clip' is meta (why_clip_selected)", () => {
  const m = parseMetaQuestion("why did you add this clip");
  assert.equal(m?.kind, "why_clip_selected");
});

test("'why did you choose this part' is meta (why_clip_selected)", () => {
  const m = parseMetaQuestion("why did you choose this part");
  assert.equal(m?.kind, "why_clip_selected");
});

test("'why this clip' is meta (why_clip_selected)", () => {
  const m = parseMetaQuestion("why this clip");
  assert.equal(m?.kind, "why_clip_selected");
});

test("'why only fade' is meta (capability_explanation)", () => {
  const m = parseMetaQuestion("why only fade");
  assert.equal(m?.kind, "capability_explanation");
});

test("'why does it use fade' is meta (capability_explanation)", () => {
  const m = parseMetaQuestion("why does it use fade?");
  assert.equal(m?.kind, "capability_explanation");
});

test("'what is unsupported' is meta (capability_explanation)", () => {
  const m = parseMetaQuestion("what is unsupported");
  assert.equal(m?.kind, "capability_explanation");
});

test("'what can this app do' is meta (capability_explanation)", () => {
  const m = parseMetaQuestion("what can this app do?");
  assert.equal(m?.kind, "capability_explanation");
});

test("'explain the plan' is meta (why_plan)", () => {
  const m = parseMetaQuestion("explain the plan");
  assert.equal(m?.kind, "why_plan");
});

test("'why is it 30 seconds' is meta (why_plan)", () => {
  const m = parseMetaQuestion("why is it 30 seconds long");
  assert.equal(m?.kind, "why_plan");
});

test("'what will happen if I render' is meta (what_will_happen)", () => {
  const m = parseMetaQuestion("what will happen if I render");
  assert.equal(m?.kind, "what_will_happen");
});

test("'what happened' is meta (explain_previous_changes), not future render", () => {
  const m = parseMetaQuestion("what happened?");
  assert.equal(m?.kind, "explain_previous_changes");
});

test("'explain these changes' is meta", () => {
  assert.ok(parseMetaQuestion("explain these changes"));
});

test("'explain the timeline' is meta (timeline target)", () => {
  const m = parseMetaQuestion("explain the timeline");
  assert.equal(m?.kind, "explain_previous_changes");
  assert.equal(m?.target, "timeline");
});

// ---- negative: edit commands are NOT meta ----------------------------
test("'change this clip' is NOT meta", () => {
  assert.equal(parseMetaQuestion("change this clip"), null);
});

test("'add explanation text' is NOT meta", () => {
  assert.equal(parseMetaQuestion("add explanation text"), null);
});

test("'add why text' is NOT meta", () => {
  assert.equal(parseMetaQuestion("add why text"), null);
});

test("'add a title saying why' is NOT meta", () => {
  assert.equal(parseMetaQuestion("add a title saying why"), null);
});

test("'make an explanation video' is NOT meta", () => {
  assert.equal(parseMetaQuestion("make an explanation video"), null);
});

test("'remove this' is NOT meta", () => {
  assert.equal(parseMetaQuestion("remove this"), null);
});

test("'replace this' is NOT meta", () => {
  assert.equal(parseMetaQuestion("replace this"), null);
});

test("'make it shorter' is NOT meta", () => {
  assert.equal(parseMetaQuestion("make it shorter"), null);
});

test("'fix the timeline' is NOT meta", () => {
  assert.equal(parseMetaQuestion("fix the timeline"), null);
});

// ---- existing edit commands flow through untouched -------------------
test("typical edit commands are not hijacked as meta", () => {
  for (const cmd of [
    "add the first 10 seconds",
    "remove clip 2",
    "render",
    "export",
    "trim clip 1 to 0:05-0:10",
    "move clip 3 before clip 1",
    "make a 30 second vertical reel"
  ]) {
    assert.equal(parseMetaQuestion(cmd), null, `"${cmd}" must not be meta`);
  }
});

test("non-question chatter is not meta", () => {
  assert.equal(parseMetaQuestion("hello there"), null);
  assert.equal(parseMetaQuestion(""), null);
});

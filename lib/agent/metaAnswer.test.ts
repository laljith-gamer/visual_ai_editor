// Tests for answerMetaQuestion — read-only explanations from current state.

import { test } from "node:test";
import assert from "node:assert/strict";

import { answerMetaQuestion, type MetaAnswerState } from "./metaAnswer.ts";
import type { MetaQuestion } from "../intent/metaQuestions.ts";

function emptyState(over: Partial<MetaAnswerState> = {}): MetaAnswerState {
  return {
    plan: null,
    highlights: [],
    selectedClipId: null,
    boundaryTransitions: [],
    memory: { styles: [], keep: [], skip: [] },
    sources: [],
    ...over
  };
}

const q = (kind: MetaQuestion["kind"], target?: MetaQuestion["target"]): MetaQuestion => ({
  kind,
  confidence: 0.9,
  target
});

// #1 — explain changes lists reasoning + never claims it touched the source.
test("explain_previous_changes explains clips, duration, transitions and source-untouched", () => {
  const state = emptyState({
    plan: { targetShortSeconds: 30, userSpecifiedDuration: true, format: "vertical", transition: "fade", scenarios: [{ id: "s1", prompt: "combat" }] },
    highlights: [
      { id: "c1", start: 0, end: 8, reason: "high motion", sourceId: "src_a", score: 0.9 },
      { id: "c2", start: 20, end: 30, reason: "cutscene", sourceId: "src_a", score: 0.8 }
    ],
    boundaryTransitions: [{ index: 1, type: "fade" }],
    sources: [{ id: "src_a", name: "gameplay.mp4" }]
  });
  const answer = answerMetaQuestion(q("explain_previous_changes"), state);
  assert.match(answer, /did not change the source/i);
  assert.match(answer, /30s|target/i);
  assert.match(answer, /fade|cut|crossfade/i);
  // It must not claim an edit it didn't make / must read as an explanation.
  assert.ok(answer.length > 0);
});

// #10 — no clips → honest "No edit has been applied yet."
test("explain_previous_changes with no clips says no edit applied yet", () => {
  const answer = answerMetaQuestion(q("explain_previous_changes"), emptyState());
  assert.match(answer, /No edit has been applied yet/i);
});

test("what_changed with no clips says no edit applied yet", () => {
  const answer = answerMetaQuestion(q("what_changed"), emptyState());
  assert.match(answer, /No edit has been applied yet/i);
});

// #3 — why this clip uses the highlight reason.
test("why_clip_selected uses the selected clip's reason + range + source", () => {
  const state = emptyState({
    highlights: [{ id: "c1", start: 5, end: 12, reason: "he scores a goal", sourceId: "src_a", score: 0.92 }],
    selectedClipId: "c1",
    sources: [{ id: "src_a", name: "match.mp4" }]
  });
  const answer = answerMetaQuestion(q("why_clip_selected"), state);
  assert.match(answer, /he scores a goal/);
  assert.match(answer, /match\.mp4/);
});

test("why_clip_selected with no clips is honest, no crash", () => {
  const answer = answerMetaQuestion(q("why_clip_selected"), emptyState());
  assert.match(answer, /No edit has been applied yet|no clip/i);
});

// #5 — explain the plan answers from plan.
test("why_plan answers from the plan (duration + format)", () => {
  const state = emptyState({
    plan: { targetShortSeconds: 45, userSpecifiedDuration: true, format: "vertical", transition: "fade", scenarios: [{ id: "s1", prompt: "best moments" }] }
  });
  const answer = answerMetaQuestion(q("why_plan"), state);
  assert.match(answer, /45s/);
  assert.match(answer, /vertical/);
  assert.match(answer, /best moments/);
});

// #9 — meta before any plan does not crash.
test("why_plan with no plan is honest, no crash", () => {
  const answer = answerMetaQuestion(q("why_plan"), emptyState());
  assert.match(answer, /no active plan|haven't planned/i);
});

// #4 — capability/fade explanation describes the renderer limitation.
test("capability_explanation about fade explains the transition limitation", () => {
  const answer = answerMetaQuestion(q("capability_explanation"), emptyState({ questionText: "why only fade" }));
  assert.match(answer, /cuts?, fades?, and a crossfade|fade dip/i);
  assert.match(answer, /slide|zoom|glitch|whip/i);
});

test("capability_explanation (general) lists honest supported/unsupported", () => {
  const answer = answerMetaQuestion(q("capability_explanation"), emptyState({ questionText: "what can this app do" }));
  assert.match(answer, /Supported/i);
  assert.match(answer, /color grad|text overlay|captions|music/i); // honest "not yet"
});

// what_will_happen prediction.
test("what_will_happen describes the render without mutating", () => {
  const state = emptyState({
    plan: { format: "vertical", transition: "fade" },
    highlights: [{ id: "c1", start: 0, end: 10 }]
  });
  const answer = answerMetaQuestion(q("what_will_happen"), state);
  assert.match(answer, /render/i);
  assert.match(answer, /not modified|aren't modified|not changed/i);
});

test("what_will_happen with empty timeline is honest", () => {
  const answer = answerMetaQuestion(q("what_will_happen"), emptyState());
  assert.match(answer, /nothing to render|empty/i);
});

// Robustness — every kind returns a non-empty string on an empty state.
test("every meta kind answers without crashing on empty state", () => {
  const kinds: MetaQuestion["kind"][] = [
    "explain_previous_changes",
    "what_changed",
    "why_clip_selected",
    "why_plan",
    "what_will_happen",
    "capability_explanation",
    "unknown"
  ];
  for (const k of kinds) {
    const answer = answerMetaQuestion(q(k), emptyState());
    assert.ok(typeof answer === "string" && answer.length > 0, `${k} should answer`);
  }
});

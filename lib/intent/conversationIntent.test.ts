// Tests for the universal conversation-intent classifier. These assert
// SEMANTIC understanding of varied phrasings — NOT exact example matching.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyConversationIntentSync,
  classifyConversationIntent,
  parseIntentClassifierJson,
  buildIntentClassifierPrompt,
  NEUTRAL_CONTEXT,
  type ConversationContext
} from "./conversationIntent.ts";

const ctx = (over: Partial<ConversationContext> = {}): ConversationContext => ({
  ...NEUTRAL_CONTEXT,
  ...over
});

// ---- READ-ONLY META (varied phrasings) -------------------------------
const READ_ONLY = [
  "tell me the reasoning behind this edit",
  "why is the timeline arranged like this",
  "what was your logic for choosing these scenes",
  "justify why this clip is here",
  "how did you decide this part",
  "what exactly did you do",
  "did you change my original video",
  "why is it only fade again",
  "why didn't the zoom happen",
  "what will happen if I render now",
  "why did the output become 20 seconds",
  "why did you make it vertical",
  "why did you not add captions",
  "what can this app actually do",
  "explain the plan",
  "why this clip"
];

for (const text of READ_ONLY) {
  test(`read-only: "${text}"`, () => {
    const intent = classifyConversationIntentSync(text);
    assert.equal(intent.kind, "read_only_meta", `kind for "${text}" (${intent.reason})`);
    assert.equal(intent.readOnly, true);
    assert.ok(intent.confidence >= 0.6, `confidence ${intent.confidence}`);
  });
}

test("targets are inferred sensibly", () => {
  assert.equal(classifyConversationIntentSync("did you change my original video").target, "source_video");
  assert.equal(classifyConversationIntentSync("what will happen if I render now").target, "render");
  assert.equal(classifyConversationIntentSync("why is it only fade again").target, "capability");
  assert.equal(classifyConversationIntentSync("why did you not add captions").target, "capability");
  assert.equal(classifyConversationIntentSync("what can this app actually do").target, "capability");
  assert.equal(classifyConversationIntentSync("justify why this clip is here").target, "selected_clip");
  assert.equal(classifyConversationIntentSync("why did you make it vertical").target, "plan");
});

// ---- MUTATION / CONTROL (must NOT be read-only) ----------------------
const MUTATION = [
  "add explanation text",
  "make an explanation video",
  "change this clip",
  "fix the timeline",
  "remove this part",
  "replace this clip",
  "make it vertical",
  "add why text at the start"
];
for (const text of MUTATION) {
  test(`mutation (not meta): "${text}"`, () => {
    const intent = classifyConversationIntentSync(text);
    assert.equal(intent.readOnly, false, `"${text}" → ${intent.kind}`);
    assert.notEqual(intent.kind, "read_only_meta");
    assert.ok(intent.kind === "edit_mutation" || intent.kind === "create_or_plan_edit");
  });
}

test("control commands classify as control_command", () => {
  assert.equal(classifyConversationIntentSync("render it").kind, "control_command");
  assert.equal(classifyConversationIntentSync("export now").kind, "control_command");
  assert.equal(classifyConversationIntentSync("render it").readOnly, false);
});

// ---- AMBIGUOUS — explain + change → read-only, never mutate ----------
test("'can you explain and fix it' is read-only + ambiguous (no mutation)", () => {
  const intent = classifyConversationIntentSync("can you explain and fix it");
  assert.equal(intent.kind, "read_only_meta");
  assert.equal(intent.readOnly, true);
  assert.equal(intent.ambiguous, true);
});

// ---- VISUAL question (needs vision; not the read-only state responder)
test("'what's in this video' is a visual_question", () => {
  assert.equal(classifyConversationIntentSync("what's in this video").kind, "visual_question");
  assert.equal(classifyConversationIntentSync("describe the footage").kind, "visual_question");
});

// ---- "watch my video" (incl. the "wath" typo) → visual_question ------
test("'watch my video' and the 'wath' typo route to visual_question", () => {
  for (const s of ["watch my video", "wath my video", "look at this video", "watch this"]) {
    const intent = classifyConversationIntentSync(s);
    assert.equal(intent.kind, "visual_question", `${s} → ${intent.kind} (${intent.reason})`);
  }
});

// ---- identity / "what model are you" → read-only capability ----------
test("identity questions classify as read_only_meta + capability", () => {
  for (const s of [
    "tell me about your model name",
    "what model are you",
    "who are you",
    "what's your name",
    "are you chatgpt",
    "which llm is this"
  ]) {
    const intent = classifyConversationIntentSync(s);
    assert.equal(intent.kind, "read_only_meta", `${s} → ${intent.kind} (${intent.reason})`);
    assert.equal(intent.target, "capability", `${s} target`);
    assert.equal(intent.readOnly, true);
  }
});

// ---- clarification answer while a clarify is pending -----------------
test("short reply during pendingClarify is a clarification_answer", () => {
  const intent = classifyConversationIntentSync("the first one", ctx({ pendingClarify: true }));
  assert.equal(intent.kind, "clarification_answer");
  assert.equal(intent.readOnly, false);
});

// ---- Layer B (semantic) orchestration --------------------------------
test("ambiguous turn is refined by the semantic classifier when available", async () => {
  let called = false;
  const semanticClassify = async () => {
    called = true;
    return '{"kind":"read_only_meta","readOnly":true,"target":"timeline","confidence":0.9,"reason":"x"}';
  };
  // A bare, edit-state-less question → Layer A unknown/low confidence.
  const intent = await classifyConversationIntent("hmm what about that", ctx(), { semanticClassify });
  assert.equal(called, true);
  assert.equal(intent.kind, "read_only_meta");
});

test("semantic classifier cannot downgrade a read-only turn to mutation unless very confident", async () => {
  const semanticClassify = async () =>
    '{"kind":"edit_mutation","readOnly":false,"target":"timeline","confidence":0.7,"reason":"x"}';
  // Ambiguous read-only (0.62) → Layer B invoked, but its low-confidence
  // mutation must NOT override the safe read-only classification.
  const intent = await classifyConversationIntent("can you explain and fix it", ctx(), { semanticClassify });
  assert.equal(intent.kind, "read_only_meta");
  assert.equal(intent.readOnly, true);
});

test("high-confidence Layer A skips the semantic classifier", async () => {
  let called = false;
  const semanticClassify = async () => {
    called = true;
    return "{}";
  };
  const intent = await classifyConversationIntent("why did you add this clip", ctx(), { semanticClassify });
  assert.equal(called, false);
  assert.equal(intent.kind, "read_only_meta");
});

// ---- JSON parse + prompt build ---------------------------------------
test("parseIntentClassifierJson reads valid JSON and rejects junk", () => {
  const ok = parseIntentClassifierJson('noise {"kind":"edit_mutation","readOnly":false,"target":"timeline","confidence":0.8} trailing');
  assert.equal(ok?.kind, "edit_mutation");
  assert.equal(parseIntentClassifierJson("not json at all"), null);
  assert.equal(parseIntentClassifierJson('{"kind":"banana"}'), null);
});

test("buildIntentClassifierPrompt embeds the context", () => {
  const { system, user } = buildIntentClassifierPrompt("why", ctx({ hasTimeline: true, clipCount: 3 }));
  assert.match(system, /classifier/i);
  assert.match(user, /hasTimeline: true/);
  assert.match(user, /clipCount: 3/);
  assert.match(user, /Never mutate on ambiguity/i);
});

test("empty input is unknown, not a mutation", () => {
  const intent = classifyConversationIntentSync("");
  assert.equal(intent.kind, "unknown");
  assert.equal(intent.readOnly, false);
});

// metaQuestions is now a thin compatibility shim over the conversation
// classifier (the brittle exact-phrase regex table was removed). These
// sanity tests confirm the adapter still flags read-only questions and
// leaves edit commands alone. The deep semantic coverage lives in
// conversationIntent.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMetaQuestion } from "./metaQuestions.ts";

test("read-only questions map to a MetaQuestion (varied phrasings)", () => {
  for (const text of [
    "why did you arrange it like this",
    "tell me the reasoning behind this edit",
    "what will happen if I render",
    "what can this app actually do",
    "did you change my original video"
  ]) {
    const m = parseMetaQuestion(text);
    assert.ok(m, `"${text}" should be a meta question`);
    assert.ok((m?.confidence ?? 0) >= 0.6);
  }
});

test("edit/control commands are not meta (null)", () => {
  for (const text of [
    "change this clip",
    "add explanation text",
    "make an explanation video",
    "remove this part",
    "render it"
  ]) {
    assert.equal(parseMetaQuestion(text), null, `"${text}" must not be meta`);
  }
});

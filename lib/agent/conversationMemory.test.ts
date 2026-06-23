import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isBackReference,
  lastSubstantiveRequest,
  buildConversationContext,
  type ConvoMessage
} from "./conversationMemory.ts";

test("isBackReference: recognizes back-references", () => {
  for (const s of [
    "what ever i said before",
    "whatever i asked",
    "do that again",
    "same as before",
    "the same thing",
    "like i said",
    "use my previous request"
  ]) {
    assert.equal(isBackReference(s), true, s);
  }
});

test("isBackReference: does NOT fire on real requests", () => {
  for (const s of [
    "make a 3 min short of the fight",
    "trim the first 5 seconds",
    "i need a vertical reel of cutscenes",
    "hi"
  ]) {
    assert.equal(isBackReference(s), false, s);
  }
});

test("lastSubstantiveRequest: returns the most recent real request", () => {
  const msgs: ConvoMessage[] = [
    { role: "assistant", content: "Hey — drop a video." },
    { role: "user", content: "this is wukong gameplay, i need a 3 min short of the fight" },
    { role: "assistant", content: "Want me to search for the fight?" },
    { role: "user", content: "not fixed center" },
    { role: "assistant", content: "What should I make?" },
    { role: "user", content: "what ever i said before" }
  ];
  const prior = lastSubstantiveRequest(msgs, "what ever i said before");
  assert.equal(prior, "this is wukong gameplay, i need a 3 min short of the fight");
});

test("lastSubstantiveRequest: skips greetings and back-references", () => {
  const msgs: ConvoMessage[] = [
    { role: "user", content: "hi" },
    { role: "user", content: "same as before" }
  ];
  assert.equal(lastSubstantiveRequest(msgs), null);
});

test("buildConversationContext: compact, newest last", () => {
  const msgs: ConvoMessage[] = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" }
  ];
  const ctx = buildConversationContext(msgs, 2);
  assert.equal(ctx, "Assistant: b\nUser: c");
});

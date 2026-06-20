import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractTopicPhrases,
  joinTopicPhrasesForDisplay,
  hasContentTopic
} from "./topicPhrases.ts";

test("preserves adjacent content phrases instead of token soup", () => {
  const phrases = extractTopicPhrases("red boy and wukong fight best combat scene for 2 min");
  // 'best' + 'scene' are meta; 'and' splits groups; 'for 2 min' is duration.
  assert.deepEqual(phrases, ["red boy", "wukong fight", "combat"]);
});

test("does NOT emit every token joined by 'and'", () => {
  const phrases = extractTopicPhrases("red boy and wukong fight");
  assert.ok(!phrases.includes("red"));
  assert.ok(!phrases.includes("boy"));
  assert.deepEqual(phrases, ["red boy", "wukong fight"]);
});

test("splits on commas and slashes", () => {
  assert.deepEqual(extractTopicPhrases("combat, dialogue / cutscene".replace(/cutscene/, "boss")), [
    "combat",
    "dialogue",
    "boss"
  ]);
});

test("pure editing/meta text yields no topic phrases", () => {
  assert.deepEqual(extractTopicPhrases("make a 1 min vertical reel of the best clips"), []);
  assert.equal(hasContentTopic("trim to fit"), false);
});

test("display join uses slashes", () => {
  assert.equal(joinTopicPhrasesForDisplay(["red boy", "wukong fight", "combat"]), "red boy / wukong fight / combat");
});

test("caps phrase count and words per phrase", () => {
  const phrases = extractTopicPhrases("alpha beta gamma delta epsilon zeta", { maxWordsPerPhrase: 3 });
  assert.equal(phrases.length, 1);
  assert.equal(phrases[0].split(" ").length, 3);
});

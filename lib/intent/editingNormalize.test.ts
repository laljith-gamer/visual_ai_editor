import { test } from "node:test";
import assert from "node:assert/strict";

import {
  damerauLevenshtein,
  normalizeEditingToken,
  normalizeEditingText
} from "./editingNormalize.ts";

test("damerau-levenshtein handles transposition as distance 1", () => {
  assert.equal(damerauLevenshtein("comabt", "combat"), 1);
  assert.equal(damerauLevenshtein("combact", "combat"), 1);
  assert.equal(damerauLevenshtein("cutsecene", "cutscene"), 1);
});

test("corrects common editing-word typos generically", () => {
  assert.equal(normalizeEditingToken("combact"), "combat");
  assert.equal(normalizeEditingToken("comabt"), "combat");
  assert.equal(normalizeEditingToken("cutsecene"), "cutscene");
  assert.equal(normalizeEditingToken("trnsition"), "transition");
});

test("leaves exact lexicon words untouched", () => {
  assert.equal(normalizeEditingToken("combat"), "combat");
  assert.equal(normalizeEditingToken("cutscene"), "cutscene");
});

test("does NOT correct real content subjects (not near a lexicon word)", () => {
  // Proper nouns / topics must be preserved verbatim — never invented.
  for (const w of ["wukong", "redboy", "naruto", "pasta", "wedding"]) {
    assert.equal(normalizeEditingToken(w), w, w);
  }
});

test("does not fuzzy-correct very short tokens", () => {
  assert.equal(normalizeEditingToken("cut"), "cut"); // exact anyway
  assert.equal(normalizeEditingToken("abc"), "abc");
});

test("normalizeEditingText fixes typos in place and reports evidence", () => {
  const r = normalizeEditingText("remove cutsecene i need only fighting combact");
  assert.match(r.normalized, /cutscene/);
  assert.match(r.normalized, /combat\b/);
  assert.ok(r.evidence.length >= 2);
});

test("normalizeEditingText preserves user topic phrases", () => {
  const r = normalizeEditingText("red boy and wukong fight combact scene");
  // 'combact' fixed, but 'wukong'/'red'/'boy' preserved
  assert.match(r.normalized, /red boy and wukong fight combat scene/);
});

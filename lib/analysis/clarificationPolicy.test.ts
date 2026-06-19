import { test } from "node:test";
import assert from "node:assert/strict";

import { decideClarification, type ClarificationInput } from "./clarificationPolicy.ts";

const base = (over: Partial<ClarificationInput> = {}): ClarificationInput => ({
  purpose: "normal_highlights",
  promptSpecificity: "normal",
  sourceCount: 1,
  ...over
});

test("clear, specific single-video request → no clarification", () => {
  const d = decideClarification(base({ promptSpecificity: "specific", quickScanConfidence: 0.8, candidateWindowStrength: 0.7 }));
  assert.equal(d.shouldAsk, false);
});

test("vague cinematic multi-video → asks style", () => {
  const d = decideClarification(base({ purpose: "deep_story", promptSpecificity: "vague", sourceCount: 3 }));
  assert.equal(d.shouldAsk, true);
  assert.equal(d.kind, "style");
  assert.ok((d.suggestions ?? []).length >= 2);
  assert.match(d.message ?? "", /story|montage/i);
});

test("low-confidence quick scan → asks before deep scan", () => {
  const d = decideClarification(base({ quickScanConfidence: 0.2 }));
  assert.equal(d.shouldAsk, true);
  assert.equal(d.kind, "deeper_scan");
});

test("weak candidate windows → asks before deep scan", () => {
  const d = decideClarification(base({ candidateWindowStrength: 0.1 }));
  assert.equal(d.shouldAsk, true);
  assert.equal(d.kind, "deeper_scan");
});

test("underfilled explicit target → asks broaden/keep", () => {
  const d = decideClarification(base({ userSpecifiedDuration: true, targetSeconds: 60, achievableSeconds: 18 }));
  assert.equal(d.shouldAsk, true);
  assert.equal(d.kind, "broaden");
  assert.match(d.message ?? "", /18s.*60s|broaden/i);
});

test("multiple content types → asks which to prioritize", () => {
  const d = decideClarification(base({ detectedContentTypes: ["talking", "action", "static"] }));
  assert.equal(d.shouldAsk, true);
  assert.equal(d.kind, "content_priority");
  assert.ok((d.suggestions ?? []).some((x) => /mix/i.test(x)));
});

test("vague single-video → asks the vibe", () => {
  const d = decideClarification(base({ promptSpecificity: "vague" }));
  assert.equal(d.shouldAsk, true);
  assert.equal(d.kind, "style");
});

test("well-filled target does not ask to broaden", () => {
  const d = decideClarification(base({ userSpecifiedDuration: true, targetSeconds: 30, achievableSeconds: 28, quickScanConfidence: 0.8 }));
  assert.equal(d.shouldAsk, false);
});

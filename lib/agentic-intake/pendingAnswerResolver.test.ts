import { test } from "node:test";
import assert from "node:assert/strict";

import { resolvePendingAnswer, type PendingQuestionContext } from "./pendingAnswerResolver.ts";

const outputTypeQ: PendingQuestionContext = {
  question: {
    id: "intake-output-type",
    prompt: "What should I make?",
    suggestions: ["One continuous short", "Best-moments reel", "Specific scene", "Merge videos as-is"],
    kind: "single-choice"
  },
  targetField: "output_type"
};

const contentFocusQ: PendingQuestionContext = {
  question: {
    id: "intake-content-focus",
    prompt: "What should I focus on?",
    suggestions: ["Best parts", "Most action", "Funny moments", "Emotional moments", "Use whole video continuously"],
    kind: "single-choice"
  },
  targetField: "content_focus"
};

// Case 4: "one continuos" resolves output_type via fuzzy + typo normalization
test("'one continuos' resolves output_type to single_continuous", () => {
  const r = resolvePendingAnswer("one continuos", outputTypeQ);
  assert.ok(r, "should resolve");
  assert.equal(r!.patch.output?.outputType, "single_continuous");
  assert.ok(r!.confidence >= 0.6);
});

// Case 5: exact chip match "One continuous short"
test("exact chip match resolves with high confidence", () => {
  const r = resolvePendingAnswer("One continuous short", outputTypeQ);
  assert.ok(r);
  assert.equal(r!.method, "exact_chip");
  assert.equal(r!.patch.output?.outputType, "single_continuous");
  assert.ok(r!.confidence >= 0.9);
});

// Case 6: free-text "travel vlog best places" answers output_type
test("'travel vlog best places' infers best_moments_reel with content hints", () => {
  const r = resolvePendingAnswer("travel vlog best places", outputTypeQ);
  assert.ok(r);
  assert.equal(r!.patch.output?.outputType, "multi_clip");
  assert.ok(r!.patch.content?.focus);
  assert.ok(r!.patch.content!.focus!.includes("travel") || r!.patch.content!.focus!.includes("places"));
});

// Case 3: "best places here" updates content_focus
test("'best places here' resolves content_focus with scope inference", () => {
  const r = resolvePendingAnswer("best places here", contentFocusQ);
  assert.ok(r);
  assert.ok(r!.patch.content?.focus?.includes("places"));
});

// Case 2: "he is a traveller pick best visits" infers highlight reel
test("'he is a traveller pick best visits' infers best-moments reel", () => {
  const r = resolvePendingAnswer("he is a traveller pick best visits", outputTypeQ);
  assert.ok(r, "should resolve");
  assert.equal(r!.patch.output?.outputType, "multi_clip");
  assert.equal(r!.patch.intentKind, "highlight_reel");
  assert.ok(r!.patch.content?.focus);
  assert.ok(r!.patch.content!.focus!.includes("travel") || r!.patch.content!.focus!.includes("visit"));
});

// Does NOT resolve unrelated text
test("unrelated text returns null (not everything is an answer)", () => {
  const r = resolvePendingAnswer("undo", outputTypeQ);
  assert.equal(r, null);
});

// Fuzzy chip match: "best moments" matches "Best-moments reel"
test("fuzzy match: 'best moments' matches the reel chip", () => {
  const r = resolvePendingAnswer("best moments", outputTypeQ);
  assert.ok(r);
  assert.equal(r!.patch.output?.outputType, "multi_clip");
});

// Merge detection
test("'merge them' matches merge chip", () => {
  const r = resolvePendingAnswer("merge them", outputTypeQ);
  assert.ok(r);
  assert.equal(r!.patch.output?.outputType, "as_is_merge");
});

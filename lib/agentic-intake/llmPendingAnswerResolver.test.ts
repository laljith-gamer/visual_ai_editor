import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chatBrainIntentToAnswer,
  shouldConsultBrain,
  resolvePendingAnswerWithBrain,
  type BrainResolveDeps
} from "./llmPendingAnswerResolver.ts";
import type { PendingQuestionContext } from "./pendingAnswerResolver.ts";
import type { ChatBrainIntent } from "../llm/chatBrainSchema.ts";

const outputTypeQ: PendingQuestionContext = {
  question: {
    id: "intake-output-type",
    prompt: "What should I make?",
    suggestions: ["One continuous short", "Best-moments reel", "Specific scene", "Merge videos as-is"],
    kind: "single-choice"
  },
  targetField: "output_type"
};

// ---- chatBrainIntentToAnswer (pure mapping) -----------------------------

test("maps best_moments_reel intent to a highlight-reel patch + focus", () => {
  const intent: ChatBrainIntent = {
    route: "answer_pending_question",
    confidence: 0.82,
    outputType: "best_moments_reel",
    contentFocus: ["travel", "places"],
    normalizedUserText: "best travel places",
    reason: "x"
  };
  const a = chatBrainIntentToAnswer(intent, "output_type");
  assert.ok(a);
  assert.equal(a!.method, "llm");
  assert.equal(a!.patch.output?.outputType, "multi_clip");
  assert.equal(a!.patch.intentKind, "highlight_reel");
  assert.equal(a!.patch.content?.focus, "travel, places");
});

test("maps one_continuous_short correctly", () => {
  const intent: ChatBrainIntent = {
    route: "answer_pending_question",
    confidence: 0.9,
    outputType: "one_continuous_short",
    normalizedUserText: "one continuous",
    reason: "x"
  };
  const a = chatBrainIntentToAnswer(intent, "output_type");
  assert.equal(a!.patch.output?.outputType, "single_continuous");
  assert.equal(a!.patch.intentKind, "continuous_clip");
});

// ---- shouldConsultBrain --------------------------------------------------

test("does NOT consult brain when deterministic confidence is high", () => {
  assert.equal(
    shouldConsultBrain({ field: "output_type", method: "exact_chip", patch: {}, summary: "", confidence: 0.95 }, true),
    false
  );
});

test("consults brain when deterministic is null or low confidence", () => {
  assert.equal(shouldConsultBrain(null, true), true);
  assert.equal(
    shouldConsultBrain({ field: "output_type", method: "contextual", patch: {}, summary: "", confidence: 0.5 }, true),
    true
  );
});

test("never consults brain when not ready", () => {
  assert.equal(shouldConsultBrain(null, false), false);
});

// ---- resolvePendingAnswerWithBrain (deterministic-first) ----------------

test("deterministic exact answer → no brain call", async () => {
  let called = 0;
  const deps: BrainResolveDeps = {
    ready: () => true,
    resolve: async () => {
      called++;
      return null;
    }
  };
  const res = await resolvePendingAnswerWithBrain("One continuous short", outputTypeQ, {}, deps);
  assert.equal(res.usedBrain, false);
  assert.equal(called, 0);
  assert.equal(res.answer!.patch.output?.outputType, "single_continuous");
});

test("ambiguous answer + ready brain → brain resolves it", async () => {
  let called = 0;
  const deps: BrainResolveDeps = {
    ready: () => true,
    resolve: async () => {
      called++;
      return {
        route: "answer_pending_question",
        confidence: 0.85,
        outputType: "best_moments_reel",
        contentFocus: ["surfing"],
        normalizedUserText: "make it about the surf bits",
        reason: "ambiguous phrasing"
      };
    }
  };
  // A phrasing the deterministic resolver can't map confidently.
  const res = await resolvePendingAnswerWithBrain("make it about the surf bits", outputTypeQ, {}, deps);
  assert.equal(called, 1);
  assert.equal(res.usedBrain, true);
  assert.equal(res.answer!.patch.output?.outputType, "multi_clip");
});

test("brain unavailable → falls back to deterministic (null) safely", async () => {
  const deps: BrainResolveDeps = { ready: () => false, resolve: async () => null };
  const res = await resolvePendingAnswerWithBrain("totally unrelated gibberish zzz", outputTypeQ, {}, deps);
  assert.equal(res.usedBrain, false);
  assert.equal(res.answer, null);
});

test("brain returns low-confidence → keeps deterministic result", async () => {
  const deps: BrainResolveDeps = {
    ready: () => true,
    resolve: async () => ({
      route: "passthrough",
      confidence: 0.2,
      normalizedUserText: "x",
      reason: "unsure"
    })
  };
  const res = await resolvePendingAnswerWithBrain("zzzz unclear", outputTypeQ, {}, deps);
  assert.equal(res.answer, null); // det was null; brain too weak to apply
});

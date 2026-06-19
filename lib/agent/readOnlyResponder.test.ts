// Tests for the read-only responder — deterministic, state-grounded answers
// plus the optional LLM path's safety check.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  answerReadOnly,
  deterministicAnswer,
  buildStateSummary,
  buildCapabilitySummary,
  type ReadOnlyState
} from "./readOnlyResponder.ts";
import type { ConversationIntent, ConversationTarget } from "../intent/conversationIntent.ts";

function state(over: Partial<ReadOnlyState> = {}): ReadOnlyState {
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

const intent = (target: ConversationTarget, over: Partial<ConversationIntent> = {}): ConversationIntent => ({
  kind: "read_only_meta",
  confidence: 0.85,
  readOnly: true,
  target,
  reason: "test",
  ...over
});

// "did you change my original video"
test("source_video answer makes clear the original is untouched", () => {
  const ans = deterministicAnswer(intent("source_video"), state({ highlights: [{ id: "c1", start: 0, end: 5 }] }));
  assert.match(ans, /have not changed your original video/i);
  assert.match(ans, /never modified|untouched/i);
});

// no timeline → honest
test("explain with no clips says no edit applied yet", () => {
  const ans = deterministicAnswer(intent("last_action"), state());
  assert.match(ans, /No edit has been applied yet/i);
});

// works with a selected clip
test("selected_clip answer uses the clip's reason", () => {
  const ans = deterministicAnswer(
    intent("selected_clip"),
    state({
      highlights: [{ id: "c1", start: 2, end: 9, reason: "he scores", sourceId: "s1" }],
      selectedClipId: "c1",
      sources: [{ id: "s1", name: "match.mp4" }]
    })
  );
  assert.match(ans, /he scores/);
});

// capability honesty
test("capability answer is honest about unsupported effects", () => {
  const ans = deterministicAnswer(intent("capability"), state({ questionText: "what can this app do" }));
  assert.match(ans, /not yet|unsupported|isn't|aren't|won't|not been/i);
});

// render target mentions an existing render
test("render answer notes an existing rendered output", () => {
  const ans = deterministicAnswer(
    intent("render"),
    state({ highlights: [{ id: "c1", start: 0, end: 4 }], hasRenderedOutput: true })
  );
  assert.match(ans, /already a rendered output|replaces it/i);
});

// ambiguous → explain + offer to apply, no mutation claim
test("ambiguous intent appends an explain-first / offer-to-apply note", () => {
  const ans = deterministicAnswer(intent("timeline", { ambiguous: true }), state({ highlights: [{ id: "c1", start: 0, end: 5 }] }));
  assert.match(ans, /haven't changed anything/i);
  assert.match(ans, /if you'?d like me to actually apply/i);
});

// LLM path: accept a good generated answer
test("answerReadOnly uses a good generated answer", async () => {
  const ans = await answerReadOnly(intent("timeline"), state({ highlights: [{ id: "c1", start: 0, end: 5 }] }), {
    generate: async () => "Your timeline has one clip selected for its strong motion; the source file is untouched."
  });
  assert.match(ans, /strong motion/);
});

// LLM path: reject an answer that falsely claims it just edited something
test("answerReadOnly rejects an action-claiming generated answer and falls back", async () => {
  const ans = await answerReadOnly(intent("timeline"), state({ highlights: [{ id: "c1", start: 0, end: 5 }] }), {
    generate: async () => "I just changed the timeline and removed two clips for you."
  });
  assert.doesNotMatch(ans, /I just changed the timeline/i);
});

// LLM path: a throwing generator falls back to deterministic
test("answerReadOnly falls back when the generator throws", async () => {
  const ans = await answerReadOnly(intent("last_action"), state(), {
    generate: async () => {
      throw new Error("engine down");
    }
  });
  assert.match(ans, /No edit has been applied yet/i);
});

// summaries
test("buildStateSummary reflects the timeline and notes the untouched source", () => {
  const summary = buildStateSummary(
    state({
      highlights: [{ id: "c1", start: 0, end: 6, reason: "goal" }],
      plan: { targetShortSeconds: 30, format: "vertical" }
    })
  );
  assert.match(summary, /1 clip/);
  assert.match(summary, /30s target|vertical/);
  assert.match(summary, /not been modified/i);
});

test("buildCapabilitySummary lists supported and not-implemented honestly", () => {
  const cap = buildCapabilitySummary();
  assert.match(cap, /Supported:/);
  assert.match(cap, /Not yet implemented/);
});

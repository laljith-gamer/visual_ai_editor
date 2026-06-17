import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyQuestion, answerQuestion, type QAContext } from "./questionAnswer.ts";

const baseCtx = (over: Partial<QAContext> = {}): QAContext => ({
  highlights: [],
  boundaryTransitions: [],
  sources: [{ id: "v1", name: "trip.mp4", duration: 600, width: 1080, height: 1920 }],
  activeSourceId: "v1",
  transcriptText: null,
  hasTranscript: false,
  ...over
});

test("describe / what's-in-this-video classify as describe_video (NOT a build)", () => {
  for (const q of [
    "Describe what's in this video",
    "what is in this video?",
    "summarize the video",
    "what happens in this footage"
  ]) {
    assert.equal(classifyQuestion(q), "describe_video", q);
  }
});

test("why-did-you-pick / explain classify as explain_picks", () => {
  for (const q of [
    "tell me why did you pick these clips explain it",
    "why did you choose these clips",
    "explain the clips",
    "why these?"
  ]) {
    assert.equal(classifyQuestion(q), "explain_picks", q);
  }
});

test("real build commands are NOT classified as questions (flow on)", () => {
  for (const q of [
    "pick best parts",
    "add first 10 seconds",
    "add the part where he says subscribe",
    "make all transitions crossfade",
    "remove clip 2"
  ]) {
    assert.equal(classifyQuestion(q), null, q);
  }
});

test("transitions question + timeline question + capabilities classify", () => {
  assert.equal(classifyQuestion("why crossfade between clip 1 and 2?"), "transitions_status");
  assert.equal(classifyQuestion("what clips do I have"), "timeline_status");
  assert.equal(classifyQuestion("what can you do"), "capabilities");
});

test("explain_picks answers from clip reasons (no build) and lists each clip", () => {
  const ctx = baseCtx({
    highlights: [
      { id: "c1", start: 0, end: 5, sourceId: "v1", label: "intro", reason: "Strong visual match", score: 0.82, confidence: "high" },
      { id: "c2", start: 30, end: 36, sourceId: "v1", reason: "Transcript match: \"subscribe\"", score: 0.7, confidence: "medium" }
    ]
  });
  const a = answerQuestion("explain_picks", ctx);
  assert.match(a.message, /2 clips/);
  assert.match(a.message, /Strong visual match/);
  assert.match(a.message, /Transcript match/);
  assert.ok(!/build a short/i.test(a.message), "must not offer to build a short as the action");
});

test("explain_picks with empty timeline is honest", () => {
  const a = answerQuestion("explain_picks", baseCtx());
  assert.match(a.message, /aren't any clips/i);
});

test("describe_video without transcript is honest (no fake visual claims)", () => {
  const a = answerQuestion("describe_video", baseCtx());
  assert.match(a.message, /trip\.mp4/);
  assert.match(a.message, /stays on this device/i);
  assert.match(a.message, /haven't visually analysed|no transcript/i);
});

test("describe_video with transcript summarizes the speech", () => {
  const a = answerQuestion("describe_video", baseCtx({
    hasTranscript: true,
    transcriptText: "Today we visit Japan and explore Tokyo street food. The ramen here is incredible and the temples are beautiful."
  }));
  assert.match(a.message, /transcript/i);
  // keyword surfaced from the speech
  assert.match(a.message.toLowerCase(), /japan|tokyo|ramen|temples|incredible/);
});

test("transitions_status lists boundaries with reasons + mapped notes", () => {
  const ctx = baseCtx({
    highlights: [{ id: "c1", start: 0, end: 5 }, { id: "c2", start: 5, end: 10 }, { id: "c3", start: 10, end: 15 }],
    boundaryTransitions: [
      { index: 1, type: "cut", mode: "auto", reason: "same source and adjacent time", render: "none", exact: true },
      { index: 2, type: "zoom", mode: "manual", reason: "set by you", render: "crossfade", exact: false, note: "Zoom isn't rendered yet — using a crossfade." }
    ]
  });
  const a = answerQuestion("transitions_status", ctx);
  assert.match(a.message, /1→2 Cut/);
  assert.match(a.message, /2→3 Zoom/);
  assert.match(a.message, /isn't rendered yet/);
});

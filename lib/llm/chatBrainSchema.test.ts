import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseChatBrainIntent,
  buildChatBrainPayload,
  payloadHasForbiddenKeys,
  FORBIDDEN_PAYLOAD_KEYS
} from "./chatBrainSchema.ts";

test("parses a valid intent and clamps confidence", () => {
  const i = parseChatBrainIntent({
    route: "create_highlight",
    confidence: 1.7,
    outputType: "best_moments_reel",
    contentFocus: ["travel", "places"],
    normalizedUserText: "best travel places",
    reason: "user wants a travel reel"
  });
  assert.ok(i);
  assert.equal(i!.route, "create_highlight");
  assert.equal(i!.confidence, 1); // clamped
  assert.equal(i!.outputType, "best_moments_reel");
  assert.deepEqual(i!.contentFocus, ["travel", "places"]);
});

test("rejects invalid / garbage JSON (strict failure → null)", () => {
  assert.equal(parseChatBrainIntent(null), null);
  assert.equal(parseChatBrainIntent("not an object"), null);
  assert.equal(parseChatBrainIntent({ confidence: 0.9 }), null); // no route
  assert.equal(parseChatBrainIntent({ route: "do_something_weird", confidence: 1 }), null);
});

test("drops unknown enum values but keeps the valid route", () => {
  const i = parseChatBrainIntent({
    route: "passthrough",
    confidence: 0.5,
    outputType: "nonsense",
    sourceScope: "mars",
    normalizedUserText: "x",
    reason: "y"
  });
  assert.ok(i);
  assert.equal(i!.outputType, undefined);
  assert.equal(i!.sourceScope, undefined);
});

test("buildChatBrainPayload includes ONLY allowed text fields", () => {
  const payload = buildChatBrainPayload({
    userMessage: "he is a traveller pick best visits",
    previousAssistantMessage: "What should I make?",
    pendingQuestion: { id: "intake-output-type", prompt: "What should I make?", suggestions: ["A", "B"] },
    activeTargetSeconds: 60,
    timelineClipCount: 3,
    selectedSourceCount: 1,
    sourceName: "trip.mp4"
  });
  assert.equal(payload.task, "resolve");
  assert.equal(payload.userMessage, "he is a traveller pick best visits");
  assert.equal(payload.activeTargetSeconds, 60);
  assert.equal(payloadHasForbiddenKeys(payload), false);
});

test("buildChatBrainPayload carries the running-goal activeSubject (length-capped)", () => {
  const payload = buildChatBrainPayload({
    userMessage: "combat scene on this",
    activeSubject: "combat moments",
    activeTargetSeconds: 60
  });
  assert.equal(payload.activeSubject, "combat moments");
  assert.equal(payload.activeTargetSeconds, 60);

  const longSubject = "x".repeat(400);
  const capped = buildChatBrainPayload({ userMessage: "hi", activeSubject: longSubject });
  assert.ok((capped.activeSubject ?? "").length <= 120);
  assert.equal(payloadHasForbiddenKeys(capped), false);
});

test("privacy: payload NEVER carries media/secret keys even if input smuggles them", () => {
  // Simulate a caller accidentally passing forbidden fields.
  const dirty = {
    userMessage: "hi",
    // @ts-expect-error — intentionally extra forbidden fields
    blob: new Uint8Array([1, 2, 3]),
    frames: ["base64..."],
    transcript: "secret transcript body",
    apiKey: "sk-123"
  };
  const payload = buildChatBrainPayload(dirty as never);
  assert.equal(payloadHasForbiddenKeys(payload), false);
  const serialized = JSON.stringify(payload);
  for (const key of FORBIDDEN_PAYLOAD_KEYS) {
    assert.ok(!Object.prototype.hasOwnProperty.call(payload, key), `payload leaked ${key}`);
  }
  assert.ok(!serialized.includes("secret transcript body"));
  assert.ok(!serialized.includes("sk-123"));
});

test("payloadHasForbiddenKeys detects nested forbidden keys", () => {
  assert.equal(payloadHasForbiddenKeys({ a: { b: { frames: [1] } } }), true);
  assert.equal(payloadHasForbiddenKeys({ a: { b: { ok: true } } }), false);
});

test("length caps prevent oversized strings", () => {
  const big = "x".repeat(5000);
  const payload = buildChatBrainPayload({ userMessage: big });
  assert.ok(payload.userMessage.length <= 500);
});

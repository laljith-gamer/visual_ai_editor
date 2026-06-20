import { test } from "node:test";
import assert from "node:assert/strict";

import {
  shouldPreload,
  preloadChatBrain,
  resolveWithChatBrain,
  getChatBrainStatus,
  __resetChatBrainForTest
} from "./chatBrainPreload.ts";

// ---- shouldPreload (pure device gating) ---------------------------------

test("shouldPreload skips when Data Saver is on", () => {
  const d = shouldPreload({ saveData: true });
  assert.equal(d.preload, false);
  assert.equal(d.reason, "save-data");
});

test("shouldPreload allows cheap cloud warmup regardless of device memory", () => {
  const d = shouldPreload({ saveData: false, deviceMemoryGb: 2 });
  assert.equal(d.preload, true); // cloud warmup is cheap
  assert.equal(d.allowLocal, false); // but local model preload is gated off
});

// ---- network-backed behaviour (fetch mocked) ----------------------------

function mockFetch(handler: (body: unknown) => unknown) {
  let calls = 0;
  (globalThis as { fetch?: unknown }).fetch = async (_url: string, init?: { body?: string }) => {
    calls++;
    const body = init?.body ? JSON.parse(init.body) : {};
    const data = handler(body);
    return {
      ok: true,
      json: async () => data
    } as unknown as Response;
  };
  return () => calls;
}

test("preloadChatBrain is idempotent (one warmup job)", async () => {
  __resetChatBrainForTest();
  const calls = mockFetch(() => ({ status: "ready" }));
  const p1 = preloadChatBrain();
  const p2 = preloadChatBrain();
  assert.equal(p1, p2, "same in-flight promise returned");
  await p1;
  await preloadChatBrain(); // already settled → no new call
  assert.equal(calls(), 1);
  assert.equal(getChatBrainStatus(), "ready");
  __resetChatBrainForTest();
});

test("unavailable provider → status unavailable, deterministic mode (no crash)", async () => {
  __resetChatBrainForTest();
  mockFetch(() => ({ status: "unavailable" }));
  const status = await preloadChatBrain();
  assert.equal(status, "unavailable");
  // resolve short-circuits to null when unavailable (no network needed)
  const intent = await resolveWithChatBrain({ userMessage: "anything" });
  assert.equal(intent, null);
  __resetChatBrainForTest();
});

test("invalid LLM JSON → resolveWithChatBrain returns null safely", async () => {
  __resetChatBrainForTest();
  // warmup ready, then resolve returns garbage intent
  let phase = 0;
  mockFetch(() => {
    phase++;
    return phase === 1 ? { status: "ready" } : { intent: { route: "garbage" } };
  });
  await preloadChatBrain();
  const intent = await resolveWithChatBrain({ userMessage: "one continuos" });
  assert.equal(intent, null); // invalid route rejected by validator
  __resetChatBrainForTest();
});

test("resolveWithChatBrain returns a valid parsed intent", async () => {
  __resetChatBrainForTest();
  let phase = 0;
  mockFetch(() => {
    phase++;
    return phase === 1
      ? { status: "ready" }
      : {
          intent: {
            route: "answer_pending_question",
            confidence: 0.8,
            outputType: "one_continuous_short",
            normalizedUserText: "one continuous",
            reason: "typo fix"
          }
        };
  });
  await preloadChatBrain();
  const intent = await resolveWithChatBrain({ userMessage: "one continuos" });
  assert.ok(intent);
  assert.equal(intent!.outputType, "one_continuous_short");
  __resetChatBrainForTest();
});

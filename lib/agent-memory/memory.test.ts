import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentMemoryStore } from "./store.ts";
import { observeUserMessage, observeClipRemoved } from "./observer.ts";
import { getRelevantMemory } from "./context.ts";

test("save/load (serialize/hydrate) round-trips flow + reinforcement + records", () => {
  const a = new AgentMemoryStore();
  a.setFlow({ activeSourceId: "v2", lastCreatedClipIds: ["c1", "c2"] });
  a.applyReinforcement({ likedClipIds: ["c1"], styleHints: ["more action"] });
  a.remember({ kind: "user_stated", key: "avoid:intro", value: true, confidence: 0.9, evidence: "user said avoid intro", source: "user" });

  const serialized = a.serialize();
  const b = new AgentMemoryStore();
  b.hydrate(serialized);

  assert.equal(b.getFlow().activeSourceId, "v2");
  assert.deepEqual(b.getFlow().lastCreatedClipIds, ["c1", "c2"]);
  assert.deepEqual(b.getReinforcement().likedClipIds, ["c1"]);
  assert.ok(b.get("user_stated", "avoid:intro"));
});

test("observed memory carries confidence + evidence", () => {
  const s = new AgentMemoryStore();
  observeClipRemoved(s, { clipId: "c9", sourceId: "v1", start: 0, end: 5 }, true);
  const rec = s.get("reinforcement", "rejected:c9");
  assert.ok(rec, "rejection record exists");
  assert.ok(rec!.confidence > 0, "has confidence");
  assert.ok(rec!.evidence.length > 0, "has evidence");
  assert.equal(rec!.source, "timeline");
});

test("direct user instruction outranks observed memory in getRelevantMemory", () => {
  const s = new AgentMemoryStore();
  // observed (lower priority)
  s.remember({ kind: "observed", key: "obs:x", value: 1, confidence: 0.9, evidence: "seen", source: "agent" });
  // user-stated (highest priority) with LOWER confidence
  s.remember({ kind: "user_stated", key: "rule:y", value: true, confidence: 0.7, evidence: "user said", source: "user" });

  const ranked = getRelevantMemory(s);
  assert.equal(ranked[0].kind, "user_stated", "user_stated must rank first despite lower confidence");
});

test("user message observer extracts avoid-intro as user_stated", () => {
  const s = new AgentMemoryStore();
  observeUserMessage(s, "please avoid the intro");
  const rec = s.get("user_stated", "avoid:intro");
  assert.ok(rec);
  assert.equal(rec!.value, true);
});

test("getRelevantMemory filters by query but always keeps user_stated rules", () => {
  const s = new AgentMemoryStore();
  s.remember({ kind: "user_stated", key: "avoid:intro", value: true, confidence: 0.9, evidence: "avoid intro", source: "user" });
  s.remember({ kind: "observed", key: "obs:dragon", value: "dragon scene", confidence: 0.8, evidence: "dragon", source: "agent" });
  s.remember({ kind: "observed", key: "obs:cooking", value: "cooking", confidence: 0.8, evidence: "cooking", source: "agent" });

  const ranked = getRelevantMemory(s, { query: "dragon" });
  const keys = ranked.map((r) => r.key);
  assert.ok(keys.includes("avoid:intro"), "user rule always kept");
  assert.ok(keys.includes("obs:dragon"), "query match kept");
  assert.ok(!keys.includes("obs:cooking"), "non-matching observed dropped");
});

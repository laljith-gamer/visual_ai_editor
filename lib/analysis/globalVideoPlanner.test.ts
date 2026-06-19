import { test } from "node:test";
import assert from "node:assert/strict";

import { planGlobalEdit, type GlobalPlanRequest } from "./globalVideoPlanner.ts";
import type { SourcePlanningSummary } from "./videoMemory.ts";

function src(over: Partial<SourcePlanningSummary>): SourcePlanningSummary {
  return {
    sourceId: "s",
    videoHash: "h",
    name: "v.mp4",
    durationSeconds: 60,
    level: 2,
    confidence: 0.7,
    motion: "mixed",
    goodWindowCount: 1,
    goodWindows: [],
    ...over
  };
}

const req = (over: Partial<GlobalPlanRequest> = {}): GlobalPlanRequest => ({
  promptSpecificity: "normal",
  ...over
});

const three = (): SourcePlanningSummary[] => [
  src({ sourceId: "v1", name: "v1.mp4", motion: "low", goodWindowCount: 1 }),
  src({ sourceId: "v2", name: "v2.mp4", motion: "high", goodWindowCount: 4 }),
  src({ sourceId: "v3", name: "v3.mp4", motion: "mixed", goodWindowCount: 1 })
];

test("single source → trivial plan, role main_only", () => {
  const p = planGlobalEdit([src({ sourceId: "only" })], req());
  assert.equal(p.needsClarification, false);
  assert.equal(p.order.length, 1);
  assert.equal(p.roles[0].role, "main_only");
});

test("multi-source assigns roles (main = strongest, intro = first, ending = last)", () => {
  const p = planGlobalEdit(three(), req({ style: "story" }));
  const byId = new Map(p.roles.map((r) => [r.sourceId, r]));
  assert.equal(byId.get("v2")?.role, "main"); // most good windows + high motion
  assert.equal(byId.get("v1")?.role, "intro");
  assert.equal(byId.get("v3")?.role, "ending");
});

test("vague multi-source story → asks style (no silent guess)", () => {
  const p = planGlobalEdit(three(), req({ promptSpecificity: "vague" }));
  assert.equal(p.needsClarification, true);
  assert.match(p.clarification?.message ?? "", /story|montage/i);
});

test("balanced mode does not let one source dominate", () => {
  const p = planGlobalEdit(three(), req({ style: "montage" }));
  assert.equal(p.strategy, "balanced");
  for (const r of p.roles) {
    assert.ok(r.targetShare <= 0.6 + 1e-9, `share ${r.targetShare} for ${r.sourceId}`);
  }
});

test("best-first lets the strongest source take the largest share", () => {
  const p = planGlobalEdit(three(), req({ bestOnly: true }));
  assert.equal(p.strategy, "best_first");
  const byId = new Map(p.roles.map((r) => [r.sourceId, r]));
  const v2 = byId.get("v2")!.targetShare;
  const v1 = byId.get("v1")!.targetShare;
  assert.ok(v2 > v1, `v2=${v2} v1=${v1}`);
});

test("explicit order is respected", () => {
  const p = planGlobalEdit(three(), req({ explicitOrder: ["v3", "v1", "v2"] }));
  assert.equal(p.strategy, "explicit");
  assert.deepEqual(p.order, ["v3", "v1", "v2"]);
});

test("source memories drive roles independently per source", () => {
  // Each summary is a separate object → planner reasons over them separately.
  const sources = three();
  const p = planGlobalEdit(sources, req({ style: "montage" }));
  assert.equal(p.roles.length, 3);
  assert.equal(new Set(p.roles.map((r) => r.sourceId)).size, 3);
});

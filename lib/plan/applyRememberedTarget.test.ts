import { test } from "node:test";
import assert from "node:assert/strict";

import { applyRememberedTarget } from "./applyRememberedTarget.ts";
import type { EditPlan } from "@/lib/types";

// Minimal plan factory — the helper only reads/writes userSpecifiedDuration +
// targetShortSeconds, so a partial cast is enough for these unit tests.
const plan = (over: Partial<EditPlan> = {}): EditPlan =>
  ({
    scenarios: [],
    labelWeights: {},
    targetShortSeconds: 0,
    userSpecifiedDuration: false,
    minClipSeconds: 1,
    maxClipSeconds: 6,
    format: "vertical",
    transition: "cut",
    selectionStrategy: "spread",
    ...over
  }) as unknown as EditPlan;

test("inherits the remembered target when the plan states no duration", () => {
  const out = applyRememberedTarget(plan({ userSpecifiedDuration: false, targetShortSeconds: 0 }), 60);
  assert.equal(out.targetShortSeconds, 60);
  assert.equal(out.userSpecifiedDuration, true);
});

test("does NOT override a duration the plan already set explicitly", () => {
  const out = applyRememberedTarget(plan({ userSpecifiedDuration: true, targetShortSeconds: 30 }), 60);
  assert.equal(out.targetShortSeconds, 30);
  assert.equal(out.userSpecifiedDuration, true);
});

test("no remembered target → plan returned unchanged", () => {
  const p = plan({ userSpecifiedDuration: false, targetShortSeconds: 0 });
  assert.equal(applyRememberedTarget(p, null), p);
  assert.equal(applyRememberedTarget(p, undefined), p);
});

test("ignores a non-positive / non-finite remembered target", () => {
  const p = plan({ userSpecifiedDuration: false });
  assert.equal(applyRememberedTarget(p, 0), p);
  assert.equal(applyRememberedTarget(p, Number.NaN), p);
});

test("transcript scenario: 60s remembered from turn 1 reaches a later subject-only plan", () => {
  // Turn 3 ("combat scene on this") produced a subject plan with no duration;
  // the remembered 60s from turn 1 must be re-applied so selection fills toward it.
  const combatPlan = plan({ userSpecifiedDuration: false, targetShortSeconds: 0 });
  const out = applyRememberedTarget(combatPlan, 60);
  assert.equal(out.userSpecifiedDuration, true);
  assert.equal(out.targetShortSeconds, 60);
});

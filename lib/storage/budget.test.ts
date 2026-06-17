import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectBudget,
  overBudgetCategories,
  shouldWarnBeforeModelDownload,
  formatBytes,
  emptyBreakdown,
  type StorageBreakdown
} from "./budget.ts";

const MB = 1024 * 1024;

test("mobile caps are tighter than desktop", () => {
  const m = selectBudget(true);
  const d = selectBudget(false);
  assert.ok(m.modelBytes < d.modelBytes);
  assert.ok(m.frameBytes < d.frameBytes);
  assert.ok(m.renderBytes < d.renderBytes);
});

test("over-budget categories reported", () => {
  const b: StorageBreakdown = {
    ...emptyBreakdown(),
    modelBytes: 700 * MB, // over both mobile (150) and desktop (600)
    frameBytes: 60 * MB, // over mobile (50), under desktop (300)
    renderBytes: 10 * MB
  };
  assert.deepEqual(overBudgetCategories(b, true).sort(), ["frame", "model"]);
  assert.deepEqual(overBudgetCategories(b, false), ["model"]);
});

test("nothing over budget when under caps", () => {
  const b: StorageBreakdown = { ...emptyBreakdown(), modelBytes: 10 * MB, frameBytes: 1 * MB, renderBytes: 1 * MB };
  assert.deepEqual(overBudgetCategories(b, true), []);
});

test("model download warning fires above threshold", () => {
  assert.equal(shouldWarnBeforeModelDownload(200 * MB), true);
  assert.equal(shouldWarnBeforeModelDownload(10 * MB), false);
});

test("formatBytes is human readable", () => {
  assert.equal(formatBytes(0), "0 MB");
  assert.match(formatBytes(5 * MB), /5\.0 MB/);
  assert.match(formatBytes(2 * 1024 * MB), /GB/);
});

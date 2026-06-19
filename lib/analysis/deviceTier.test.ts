import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyDeviceTier } from "./deviceTier.ts";

test("no signals → unknown", () => {
  assert.equal(classifyDeviceTier({}), "unknown");
});

test("WebGPU + many cores → high", () => {
  assert.equal(classifyDeviceTier({ webgpu: true, hardwareConcurrency: 12 }), "high");
});

test("WebGPU + high memory → high", () => {
  assert.equal(classifyDeviceTier({ webgpu: true, deviceMemoryGB: 8 }), "high");
});

test("decent CPU without GPU → mid (not high)", () => {
  assert.equal(classifyDeviceTier({ webgpu: false, hardwareConcurrency: 6 }), "mid");
});

test("4GB memory → mid", () => {
  assert.equal(classifyDeviceTier({ deviceMemoryGB: 4 }), "mid");
});

test("weak phone (2 cores, no gpu) → low", () => {
  assert.equal(classifyDeviceTier({ webgpu: false, hardwareConcurrency: 2, deviceMemoryGB: 2 }), "low");
});

test("WebGPU alone but weak CPU/memory → mid at best, not high", () => {
  const tier = classifyDeviceTier({ webgpu: true, hardwareConcurrency: 2, deviceMemoryGB: 2 });
  assert.notEqual(tier, "high");
});

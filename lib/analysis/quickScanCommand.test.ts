// Tests for the explicit quick-scan command detector.

import { test } from "node:test";
import assert from "node:assert/strict";

import { detectQuickScanCommand } from "./quickScanCommand.ts";

test("detects the describe chip text", () => {
  assert.deepEqual(detectQuickScanCommand("Run a quick local scan"), { kind: "quick" });
});

test("detects short forms", () => {
  for (const s of ["quick scan", "scan this video", "scan it", "local scan", "do a quick scan"]) {
    assert.equal(detectQuickScanCommand(s)?.kind, "quick", s);
  }
});

test("detects deeper-scan commands", () => {
  for (const s of ["Run a deeper local scan", "deeper scan", "scan deeper", "deep local scan"]) {
    assert.equal(detectQuickScanCommand(s)?.kind, "deep", s);
  }
});

test("does NOT fire on content searches that merely contain 'scan'", () => {
  for (const s of [
    "scan for the part where he scores",
    "find the scan results on screen",
    "make a reel of the best parts",
    "add the first 30 seconds"
  ]) {
    assert.equal(detectQuickScanCommand(s), null, s);
  }
});

test("accepting the deeper-scan offer phrased around confidence → deep", () => {
  for (const s of [
    "ok analys for high confidence",
    "okay analyse for high confidence",
    "analyze for higher confidence",
    "scan for high confidence",
    "improve confidence",
    "i need higher confidence",
    "recheck for better accuracy"
  ]) {
    assert.equal(detectQuickScanCommand(s)?.kind, "deep", s);
  }
});

test("'confidence' alone (no action/quality word) does not fire", () => {
  // A bare statement isn't a command; let it flow to the normal path.
  assert.equal(detectQuickScanCommand("the confidence"), null);
});

test("empty / whitespace → null", () => {
  assert.equal(detectQuickScanCommand(""), null);
  assert.equal(detectQuickScanCommand("   "), null);
});

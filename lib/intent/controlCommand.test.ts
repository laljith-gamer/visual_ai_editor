// =====================================================================
// lib/intent/controlCommand.test.ts
//
// Unit tests for the minimal safe control-command classifier.
// Verifies that ONLY 4 bare commands match, and everything else
// passes through to the AI router.
// =====================================================================

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyControlCommand } from "./controlCommand.ts";

describe("classifyControlCommand", () => {
  // ---- Should match (bare control commands) ----
  it("matches bare 'undo'", () => {
    assert.deepStrictEqual(classifyControlCommand("undo"), { action: "undo", matchedText: "undo" });
  });
  it("matches 'undo that'", () => {
    assert.deepStrictEqual(classifyControlCommand("undo that"), { action: "undo", matchedText: "undo that" });
  });
  it("matches 'undo it'", () => {
    assert.deepStrictEqual(classifyControlCommand("undo it"), { action: "undo", matchedText: "undo it" });
  });
  it("matches 'redo'", () => {
    assert.deepStrictEqual(classifyControlCommand("redo"), { action: "redo", matchedText: "redo" });
  });
  it("matches 'render'", () => {
    assert.deepStrictEqual(classifyControlCommand("render"), { action: "render", matchedText: "render" });
  });
  it("matches 'render it'", () => {
    assert.deepStrictEqual(classifyControlCommand("render it"), { action: "render", matchedText: "render it" });
  });
  it("matches 'export'", () => {
    assert.deepStrictEqual(classifyControlCommand("export"), { action: "export", matchedText: "export" });
  });
  it("matches 'download'", () => {
    assert.deepStrictEqual(classifyControlCommand("download"), { action: "export", matchedText: "download" });
  });
  it("matches 'save it'", () => {
    assert.deepStrictEqual(classifyControlCommand("save it"), { action: "export", matchedText: "save it" });
  });
  it("matches 'go back'", () => {
    assert.deepStrictEqual(classifyControlCommand("go back"), { action: "undo", matchedText: "go back" });
  });
  it("matches case-insensitively", () => {
    assert.deepStrictEqual(classifyControlCommand("UNDO"), { action: "undo", matchedText: "UNDO" });
  });
  it("matches with trailing punctuation", () => {
    assert.deepStrictEqual(classifyControlCommand("undo!"), { action: "undo", matchedText: "undo!" });
  });

  // ---- Should NOT match (these go to the AI router) ----
  it("does not match 'yes'", () => {
    assert.strictEqual(classifyControlCommand("yes"), null);
  });
  it("does not match 'ok do it'", () => {
    assert.strictEqual(classifyControlCommand("ok do it"), null);
  });
  it("does not match 'cancel'", () => {
    assert.strictEqual(classifyControlCommand("cancel"), null);
  });
  it("does not match 'no'", () => {
    assert.strictEqual(classifyControlCommand("no"), null);
  });
  it("does not match 'make a 30s reel'", () => {
    assert.strictEqual(classifyControlCommand("make a 30s reel"), null);
  });
  it("does not match 'undo the changes and make it better'", () => {
    assert.strictEqual(classifyControlCommand("undo the changes and make it better"), null);
  });
  it("does not match 'render the part where he scores'", () => {
    assert.strictEqual(classifyControlCommand("render the part where he scores"), null);
  });
  it("does not match 'export the cooking section'", () => {
    assert.strictEqual(classifyControlCommand("export the cooking section"), null);
  });
  it("does not match 'vertical'", () => {
    assert.strictEqual(classifyControlCommand("vertical"), null);
  });
  it("does not match 'switch to video 2'", () => {
    assert.strictEqual(classifyControlCommand("switch to video 2"), null);
  });
  it("does not match 'use all videos'", () => {
    assert.strictEqual(classifyControlCommand("use all videos"), null);
  });
  it("does not match empty input", () => {
    assert.strictEqual(classifyControlCommand(""), null);
  });
  it("does not match whitespace", () => {
    assert.strictEqual(classifyControlCommand("   "), null);
  });

  // ---- Word count guard ----
  it("rejects long sentences even if they start with a control word", () => {
    assert.strictEqual(classifyControlCommand("undo the thing you just did please"), null);
  });
});

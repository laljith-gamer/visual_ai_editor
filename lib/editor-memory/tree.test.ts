import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTree,
  setMemory,
  reinforce,
  getValue,
  getNode,
  forget,
  pruneTree,
  promote,
  flatten,
  serialize,
  deserialize
} from "./tree.ts";

const NOW = 1_000_000;

test("set + get a leaf at a path, creating branches", () => {
  const t = createTree();
  setMemory(t, ["user", "format"], "vertical", { confidence: 0.7, evidence: "x", now: NOW });
  assert.equal(getValue(t, ["user", "format"]), "vertical");
  const n = getNode(t, ["user", "format"]);
  assert.equal(n?.confidence, 0.7);
  assert.equal(n?.evidence, "x");
  assert.equal(n?.hits, 1);
});

test("get returns null for a missing path", () => {
  const t = createTree();
  assert.equal(getValue(t, ["nope", "missing"]), null);
  assert.equal(getNode(t, ["a", "b"]), null);
});

test("reinforce: same value bumps hits + confidence (capped < 1)", () => {
  const t = createTree();
  reinforce(t, ["user", "pacing"], "fast", { now: NOW });
  reinforce(t, ["user", "pacing"], "fast", { now: NOW });
  reinforce(t, ["user", "pacing"], "fast", { now: NOW });
  const n = getNode(t, ["user", "pacing"])!;
  assert.equal(n.value, "fast");
  assert.equal(n.hits, 3);
  assert.ok(n.confidence! > 0.5 && n.confidence! < 1);
});

test("reinforce: a changed value resets the streak", () => {
  const t = createTree();
  reinforce(t, ["user", "format"], "vertical", { now: NOW });
  reinforce(t, ["user", "format"], "vertical", { now: NOW });
  reinforce(t, ["user", "format"], "horizontal", { now: NOW });
  const n = getNode(t, ["user", "format"])!;
  assert.equal(n.value, "horizontal");
  assert.equal(n.hits, 1);
});

test("forget removes a leaf and prunes the empty branch", () => {
  const t = createTree();
  setMemory(t, ["source", "h1", "avoid"], ["intro"], { now: NOW });
  forget(t, ["source", "h1", "avoid"]);
  assert.equal(getValue(t, ["source", "h1", "avoid"]), null);
  // the now-empty source/h1 branch is gone too
  assert.equal(getNode(t, ["source", "h1"]), null);
  assert.equal(getNode(t, ["source"]), null);
});

test("pruneTree drops low-confidence and stale leaves", () => {
  const t = createTree();
  setMemory(t, ["user", "weak"], "x", { confidence: 0.2, now: NOW });
  setMemory(t, ["user", "strong"], "y", { confidence: 0.9, now: NOW });
  setMemory(t, ["user", "old"], "z", { confidence: 0.9, now: NOW - 10_000 });
  pruneTree(t, { minConfidence: 0.3, maxAgeMs: 5000, now: NOW });
  assert.equal(getValue(t, ["user", "weak"]), null, "weak dropped");
  assert.equal(getValue(t, ["user", "old"]), null, "stale dropped");
  assert.equal(getValue(t, ["user", "strong"]), "y", "strong kept");
});

test("promote copies a well-earned session habit up to user scope", () => {
  const t = createTree();
  reinforce(t, ["session", "format"], "vertical", { now: NOW });
  reinforce(t, ["session", "format"], "vertical", { now: NOW });
  reinforce(t, ["session", "format"], "vertical", { now: NOW });
  const ok = promote(t, ["session", "format"], ["user", "format"], { minHits: 3, minConfidence: 0.7, now: NOW });
  assert.equal(ok, true);
  assert.equal(getValue(t, ["user", "format"]), "vertical");
});

test("promote will NOT override a higher-confidence instruction at the target", () => {
  const t = createTree();
  setMemory(t, ["user", "format"], "horizontal", { confidence: 1, evidence: "explicit rule", now: NOW });
  reinforce(t, ["session", "format"], "vertical", { now: NOW });
  reinforce(t, ["session", "format"], "vertical", { now: NOW });
  reinforce(t, ["session", "format"], "vertical", { now: NOW });
  const ok = promote(t, ["session", "format"], ["user", "format"], { minHits: 3, minConfidence: 0.7, now: NOW });
  assert.equal(ok, false);
  assert.equal(getValue(t, ["user", "format"]), "horizontal", "instruction wins");
});

test("flatten returns confidence-filtered leaves, strongest first", () => {
  const t = createTree();
  setMemory(t, ["user", "format"], "vertical", { confidence: 0.9, evidence: "3x", now: NOW });
  setMemory(t, ["user", "duration"], 30, { confidence: 0.6, now: NOW });
  setMemory(t, ["user", "noise"], "x", { confidence: 0.2, now: NOW });
  const flat = flatten(t, ["user"], { minConfidence: 0.5 });
  assert.equal(flat.length, 2);
  assert.equal(flat[0].value, "vertical");
  assert.deepEqual(flat[0].path, ["user", "format"]);
  assert.ok(flat[0].confidence >= flat[1].confidence);
});

test("serialize / deserialize round-trips; bad input → fresh tree", () => {
  const t = createTree();
  setMemory(t, ["user", "format"], "square", { confidence: 0.8, now: NOW });
  const round = deserialize(serialize(t));
  assert.equal(getValue(round, ["user", "format"]), "square");
  assert.equal(getValue(deserialize("{bad json"), ["anything"]), null);
  assert.equal(deserialize(null).root && typeof deserialize(null).root, "object");
});

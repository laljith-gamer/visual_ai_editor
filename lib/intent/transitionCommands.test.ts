import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTransitionCommand, parseTransitionType } from "./transitionCommands.ts";

test("parseTransitionType maps words (incl. multi-word) to types", () => {
  assert.equal(parseTransitionType("make it a cut"), "cut");
  assert.equal(parseTransitionType("use a crossfade"), "crossfade");
  assert.equal(parseTransitionType("dip to black please"), "dip_to_black");
  assert.equal(parseTransitionType("a match cut"), "match_cut");
  assert.equal(parseTransitionType("zoom transition"), "zoom");
  assert.equal(parseTransitionType("nothing here"), null);
});

test("auto pick transitions → auto_all", () => {
  for (const t of ["auto pick transitions", "make transitions automatic", "reset transitions to auto"]) {
    assert.deepEqual(parseTransitionCommand(t), { kind: "auto_all" }, t);
  }
});

test("add fade between clip 1 and 2 → set_between (adjacent only)", () => {
  assert.deepEqual(parseTransitionCommand("add fade between clip 1 and 2"), {
    kind: "set_between",
    clipA: 1,
    clipB: 2,
    type: "fade"
  });
  assert.deepEqual(parseTransitionCommand("set transition between clip 2 and 3 to crossfade"), {
    kind: "set_between",
    clipA: 2,
    clipB: 3,
    type: "crossfade"
  });
  // non-adjacent → not a single boundary → null (falls through)
  assert.equal(parseTransitionCommand("add fade between clip 1 and 3"), null);
});

test("make all transitions crossfade → set_all crossfade", () => {
  const c = parseTransitionCommand("make all transitions crossfade");
  assert.equal(c?.kind, "set_all");
  if (c?.kind === "set_all") assert.equal(c.type, "crossfade");
});

test("remove transitions → set_all cut", () => {
  const c = parseTransitionCommand("remove transitions");
  assert.equal(c?.kind, "set_all");
  if (c?.kind === "set_all") assert.equal(c.type, "cut");
});

test("make cuts faster → set_all cut", () => {
  const c = parseTransitionCommand("make the cuts faster");
  assert.equal(c?.kind, "set_all");
  if (c?.kind === "set_all") assert.equal(c.type, "cut");
});

test("smoother/cinematic → set_all crossfade", () => {
  const c = parseTransitionCommand("make the transitions smoother");
  assert.equal(c?.kind, "set_all");
  if (c?.kind === "set_all") assert.equal(c.type, "crossfade");
});

test("unrelated text → null (falls through to planner)", () => {
  assert.equal(parseTransitionCommand("add the part where he scores"), null);
  assert.equal(parseTransitionCommand("pick best parts"), null);
  assert.equal(parseTransitionCommand(""), null);
});

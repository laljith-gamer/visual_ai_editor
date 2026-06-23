import { test } from "node:test";
import assert from "node:assert/strict";

import { parseReframeIntent } from "./reframeCommand.ts";

test("recognizes dynamic / not-fixed-center framing intent", () => {
  for (const s of [
    "not fixed center",
    "not only fixed center",
    "don't always center",
    "make it dynamic reframe",
    "follow the action",
    "stay on the subject",
    "keep the player in frame",
    "smart reframe"
  ]) {
    assert.equal(parseReframeIntent(s)?.wants, "dynamic", s);
  }
});

test("recognizes a fixed-center request", () => {
  assert.equal(parseReframeIntent("keep it centered")?.wants, "center");
  assert.equal(parseReframeIntent("fixed center")?.wants, "center");
  assert.equal(parseReframeIntent("center crop")?.wants, "center");
});

test("recognizes a framing question", () => {
  assert.equal(parseReframeIntent("does it always center the crop?")?.wants, "explain");
  assert.equal(parseReframeIntent("how does reframing work")?.wants, "explain");
});

test("does NOT fire on a create request that merely mentions framing", () => {
  assert.equal(
    parseReframeIntent(
      "i need 3 min shorts with not only fixed center based dynamic and stay posiion based on scene confidence"
    ),
    null
  );
  assert.equal(parseReframeIntent("make a 30s vertical reel of the fight"), null);
  assert.equal(parseReframeIntent("trim the first 5 seconds"), null);
});

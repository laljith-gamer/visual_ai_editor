import { test } from "node:test";
import assert from "node:assert/strict";
import { mapTransition, toRenderable, describeMappedDowns } from "./map.ts";
import {
  isRenderImplemented,
  normalizeTransitionDuration,
  withTransitionDefaults,
  ALL_TRANSITION_TYPES
} from "./types.ts";

test("cut/fade/crossfade map exactly to renderable", () => {
  assert.deepEqual(
    { render: mapTransition("cut").render, exact: mapTransition("cut").exact },
    { render: "none", exact: true }
  );
  assert.deepEqual(
    { render: mapTransition("fade").render, exact: mapTransition("fade").exact },
    { render: "fade", exact: true }
  );
  assert.deepEqual(
    { render: mapTransition("crossfade").render, exact: mapTransition("crossfade").exact },
    { render: "crossfade", exact: true }
  );
});

test("dip_to_black/slide/zoom map down and are flagged not-exact with a note", () => {
  for (const t of ["dip_to_black", "slide", "zoom"] as const) {
    const m = mapTransition(t);
    assert.equal(m.exact, false, t);
    assert.ok(["fade", "crossfade"].includes(m.render), `${t} → ${m.render}`);
    assert.ok(m.note && /isn't rendered yet/.test(m.note), `${t} note`);
  }
});

test("glitch/whip/match_cut are NOT claimed as rendered", () => {
  for (const t of ["glitch", "whip", "match_cut"] as const) {
    const m = mapTransition(t);
    assert.equal(m.exact, false, t);
    assert.ok(m.note, `${t} must carry an honest note`);
  }
  // match_cut renders as a hard cut.
  assert.equal(mapTransition("match_cut").render, "none");
});

test("toRenderable returns only worker-supported values", () => {
  for (const t of ALL_TRANSITION_TYPES) {
    assert.ok(["none", "fade", "crossfade"].includes(toRenderable(t)), t);
  }
});

test("isRenderImplemented true only for cut/fade/crossfade", () => {
  assert.equal(isRenderImplemented("cut"), true);
  assert.equal(isRenderImplemented("fade"), true);
  assert.equal(isRenderImplemented("crossfade"), true);
  assert.equal(isRenderImplemented("zoom"), false);
  assert.equal(isRenderImplemented("glitch"), false);
});

test("duration defaults + clamp via centralized guardrails", () => {
  assert.equal(normalizeTransitionDuration(undefined), 0.4);
  assert.equal(normalizeTransitionDuration(0), 0.4);
  assert.equal(normalizeTransitionDuration(0.25), 0.25);
  assert.equal(normalizeTransitionDuration(5), 1.0); // clamped to max
  const filled = withTransitionDefaults({ index: 2, type: "fade" });
  assert.equal(filled.durationSeconds, 0.4);
});

test("describeMappedDowns is empty when all exact, lists down-maps otherwise", () => {
  assert.equal(describeMappedDowns(["cut", "fade", "crossfade"]), "");
  const msg = describeMappedDowns(["fade", "zoom", "glitch"]);
  assert.match(msg, /Zoom/);
  assert.match(msg, /Glitch/);
  assert.ok(!/Fade →/.test(msg), "exact transitions are not listed as down-maps");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFilterComplex,
  computeClipFades,
  type FilterHighlight
} from "./renderFilters.ts";

const clips = (n: number): FilterHighlight[] =>
  Array.from({ length: n }, (_, i) => ({ start: i * 5, end: i * 5 + 5, inputIndex: 0 }));

test("computeClipFades — global fade applies in+out to every clip", () => {
  const f = computeClipFades(3, { transition: "fade" });
  assert.deepEqual(f, [
    { in: true, out: true },
    { in: true, out: true },
    { in: true, out: true }
  ]);
});

test("computeClipFades — global none/cut applies no fades", () => {
  assert.deepEqual(computeClipFades(2, { transition: "none" }), [
    { in: false, out: false },
    { in: false, out: false }
  ]);
});

test("computeClipFades — per-boundary derives in/out from neighbours", () => {
  // boundaryRenders[i] = transition BEFORE clip i (index 0 = lead-in).
  // [none, fade, none] over 3 clips:
  //   clip0: in=before(none)=false, out=boundary[1](fade)=true
  //   clip1: in=boundary[1](fade)=true, out=boundary[2](none)=false
  //   clip2: in=boundary[2](none)=false, out=boundary[3](undef)=false
  const f = computeClipFades(3, { boundaryRenders: ["none", "fade", "none"] });
  assert.deepEqual(f, [
    { in: false, out: true },
    { in: true, out: false },
    { in: false, out: false }
  ]);
});

test("per-boundary takes priority over global transition", () => {
  const f = computeClipFades(2, { transition: "fade", boundaryRenders: ["none", "none"] });
  assert.deepEqual(f, [
    { in: false, out: false },
    { in: false, out: false }
  ]);
});

test("global 'none' graph has no fade filters but valid concat", () => {
  const g = buildFilterComplex({ highlights: clips(2), format: "vertical", withAudio: false, transition: "none" });
  assert.ok(!g.includes("fade="), "no video fade");
  assert.ok(g.includes("concat=n=2:v=1:a=0[outv]"), "valid concat → [outv]");
});

test("global 'fade' graph fades every clip in and out (back-compat)", () => {
  const g = buildFilterComplex({ highlights: clips(2), format: "vertical", withAudio: false, transition: "fade" });
  assert.equal((g.match(/fade=t=in/g) ?? []).length, 2);
  assert.equal((g.match(/fade=t=out/g) ?? []).length, 2);
});

test("per-boundary graph fades only at the chosen boundary", () => {
  // boundary 1→2 is a fade; both clips touch it (clip0 out, clip1 in).
  const g = buildFilterComplex({
    highlights: clips(2),
    format: "vertical",
    withAudio: false,
    boundaryRenders: ["none", "fade"]
  });
  assert.equal((g.match(/fade=t=out/g) ?? []).length, 1, "clip0 fades out");
  assert.equal((g.match(/fade=t=in/g) ?? []).length, 1, "clip1 fades in");
});

test("audio chains + afade emitted only with audio", () => {
  const withA = buildFilterComplex({ highlights: clips(2), format: "square", withAudio: true, transition: "fade" });
  assert.ok(withA.includes("[outv][outa]"));
  assert.ok(withA.includes("afade=t=in"));
  const noA = buildFilterComplex({ highlights: clips(2), format: "square", withAudio: false, transition: "fade" });
  assert.ok(!noA.includes("afade"));
});

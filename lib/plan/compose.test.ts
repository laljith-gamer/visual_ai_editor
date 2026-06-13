// Regression tests for the multi-source COMPOSE (montage) resolvers.
//
// Run with:  npm run test:compose
// (Node's built-in test runner + --experimental-strip-types, so no test
//  framework dependency is added. The compose* modules are import-free at
//  runtime — only `import type` — on purpose so this works.)

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeComposePlan } from "./composeNormalize.ts";
import {
  resolveComposeSourceRef,
  resolveComposeSources,
  type ResolvableSource
} from "./composeResolve.ts";
import { orderComposedClips, makeRng } from "./composeOrder.ts";
import {
  resolveComposeTransition,
  mapToRender,
  categorizeQuery
} from "./composeTransition.ts";

// ---------------------------------------------------------------------
// normalizeComposePlan
// ---------------------------------------------------------------------

test("normalize: minimal two-source envelope → defaults applied", () => {
  const plan = normalizeComposePlan({
    sources: [
      { sourceRef: { type: "index", index: 0 }, query: "combat moments" },
      { sourceRef: { type: "index", index: 1 }, query: "cutscene" }
    ]
  });
  assert.ok(plan);
  assert.equal(plan!.sources.length, 2);
  assert.equal(plan!.ordering.type, "source_order");
  assert.equal(plan!.transition.type, "auto");
  assert.equal(plan!.needsAnalysis, true);
  assert.equal(plan!.outputTarget.type, "new_timeline_slot");
});

test("normalize: empty / invalid sources → null", () => {
  assert.equal(normalizeComposePlan({ sources: [] }), null);
  assert.equal(normalizeComposePlan({ sources: [{ query: "x" }] }), null);
  assert.equal(normalizeComposePlan({}), null);
});

test("normalize: clamps clipCount and infers userSpecifiedDuration", () => {
  const plan = normalizeComposePlan({
    sources: [
      { sourceRef: { type: "index", index: 0 }, query: "a", clipCount: 99 }
    ],
    targetSeconds: 45
  });
  assert.ok(plan);
  assert.equal(plan!.sources[0].clipCount, 12);
  assert.equal(plan!.targetSeconds, 45);
  assert.equal(plan!.userSpecifiedDuration, true);
});

test("normalize: forgiving ref — bare sourceId implies type id", () => {
  const plan = normalizeComposePlan({
    sources: [{ sourceRef: { sourceId: "src_abc" }, query: "x" }]
  });
  assert.ok(plan);
  assert.equal(plan!.sources[0].sourceRef.type, "id");
  assert.equal(plan!.sources[0].sourceRef.sourceId, "src_abc");
});

test("normalize: anchorFirst + shuffle ordering preserved", () => {
  const plan = normalizeComposePlan({
    sources: [
      { sourceRef: { type: "index", index: 0 }, query: "a" },
      { sourceRef: { type: "index", index: 1 }, query: "b" }
    ],
    ordering: { type: "shuffle", anchorFirst: true }
  });
  assert.equal(plan!.ordering.type, "shuffle");
  assert.equal(plan!.ordering.anchorFirst, true);
});

// ---------------------------------------------------------------------
// resolveComposeSources
// ---------------------------------------------------------------------

const LIB: ResolvableSource[] = [
  { id: "src_0", name: "gameplay_raw.mp4", index: 0, selected: true, active: true },
  { id: "src_1", name: "story_cutscene.mp4", index: 1, selected: true, active: false },
  { id: "src_2", name: "funny_bloopers.mp4", index: 2, selected: false, active: false }
];

test("resolve: first/second video by index", () => {
  assert.equal(resolveComposeSourceRef({ type: "index", index: 0 }, LIB)?.id, "src_0");
  assert.equal(resolveComposeSourceRef({ type: "index", index: 1 }, LIB)?.id, "src_1");
  assert.equal(resolveComposeSourceRef({ type: "index", index: 9 }, LIB), null);
});

test("resolve: active and id", () => {
  assert.equal(resolveComposeSourceRef({ type: "active" }, LIB)?.id, "src_0");
  assert.equal(resolveComposeSourceRef({ type: "id", sourceId: "src_2" }, LIB)?.id, "src_2");
  assert.equal(resolveComposeSourceRef({ type: "id", sourceId: "nope" }, LIB), null);
});

test("resolve: filename / semantic hint", () => {
  assert.equal(
    resolveComposeSourceRef({ type: "semantic_hint", hint: "the funny one" }, LIB)?.id,
    "src_2"
  );
  assert.equal(
    resolveComposeSourceRef({ type: "filename_hint", hint: "cutscene" }, LIB)?.id,
    "src_1"
  );
});

test("resolve: full selection list + unresolved bucket", () => {
  const { resolved, unresolved } = resolveComposeSources(
    [
      { sourceRef: { type: "index", index: 0 }, query: "combat" },
      { sourceRef: { type: "index", index: 1 }, query: "cutscene" },
      { sourceRef: { type: "index", index: 5 }, query: "missing" }
    ],
    LIB
  );
  assert.equal(resolved.length, 2);
  assert.equal(resolved[0].source.id, "src_0");
  assert.equal(resolved[1].source.id, "src_1");
  assert.equal(unresolved.length, 1);
});

test("resolve: two ambiguous 'selected' refs map to distinct sources", () => {
  const { resolved } = resolveComposeSources(
    [
      { sourceRef: { type: "selected" }, query: "a" },
      { sourceRef: { type: "selected" }, query: "b" }
    ],
    LIB
  );
  assert.equal(resolved.length, 2);
  assert.notEqual(resolved[0].source.id, resolved[1].source.id);
});

// ---------------------------------------------------------------------
// orderComposedClips
// ---------------------------------------------------------------------

type C = {
  sourceOrder: number;
  userOrder?: number;
  role?: "intro" | "main" | "ending" | "segment" | "middle" | "insert";
  start: number;
  score: number;
  tag: string;
};

const clips: C[] = [
  { sourceOrder: 1, start: 5, score: 0.9, tag: "b1", role: "ending" },
  { sourceOrder: 0, start: 2, score: 0.5, tag: "a1", role: "intro" },
  { sourceOrder: 0, start: 8, score: 0.7, tag: "a2", role: "intro" },
  { sourceOrder: 1, start: 1, score: 0.6, tag: "b2", role: "ending" }
];

test("order: source_order = source then start", () => {
  const out = orderComposedClips(clips, { type: "source_order" }).map((c) => c.tag);
  assert.deepEqual(out, ["a1", "a2", "b2", "b1"]);
});

test("order: interleave round-robins across sources", () => {
  const out = orderComposedClips(clips, { type: "interleave" }).map((c) => c.tag);
  // round 1: a1 (src0 first), b2 (src1 first) ; round 2: a2, b1
  assert.deepEqual(out, ["a1", "b2", "a2", "b1"]);
});

test("order: anchorFirst pins the lead then orders the rest", () => {
  const out = orderComposedClips(
    clips,
    { type: "shuffle", anchorFirst: true },
    makeRng(42)
  );
  // Lead is the source_order winner (a1); it must stay first.
  assert.equal(out[0].tag, "a1");
  assert.equal(out.length, clips.length);
});

test("order: shuffle is deterministic for a fixed seed", () => {
  const a = orderComposedClips(clips, { type: "shuffle" }, makeRng(7)).map((c) => c.tag);
  const b = orderComposedClips(clips, { type: "shuffle" }, makeRng(7)).map((c) => c.tag);
  assert.deepEqual(a, b);
});

test("order: story_arc puts intro before ending", () => {
  const out = orderComposedClips(clips, { type: "story_arc" }).map((c) => c.tag);
  assert.ok(out.indexOf("a1") < out.indexOf("b1"));
  assert.ok(out.indexOf("a2") < out.indexOf("b1"));
});

test("order: energy_curve peaks in the middle", () => {
  const out = orderComposedClips(clips, { type: "energy_curve" });
  const mid = out[Math.floor(out.length / 2)];
  const maxScore = Math.max(...clips.map((c) => c.score));
  // The highest-scoring clip should sit at/around the centre, not an edge.
  assert.equal(out[0].score <= mid.score, true);
  assert.equal(out[out.length - 1].score <= maxScore, true);
});

// ---------------------------------------------------------------------
// resolveComposeTransition
// ---------------------------------------------------------------------

test("transition: explicit types map down honestly", () => {
  assert.equal(mapToRender("fade"), "fade");
  assert.equal(mapToRender("crossfade"), "crossfade");
  assert.equal(mapToRender("glitch"), "crossfade");
  assert.equal(mapToRender("whip"), "crossfade");
  assert.equal(mapToRender("cut"), "none");
  assert.equal(mapToRender("match_cut"), "none");
});

test("transition: explicit request keeps intended, maps render", () => {
  const r = resolveComposeTransition(
    { type: "glitch" },
    { query: "combat" },
    { query: "cutscene" }
  );
  assert.equal(r.intended, "glitch");
  assert.equal(r.render, "crossfade");
});

test("transition: auto action→action = hard cut", () => {
  const r = resolveComposeTransition(
    { type: "auto" },
    { query: "combat moments" },
    { query: "fight scene" }
  );
  assert.equal(r.intended, "cut");
  assert.equal(r.render, "none");
});

test("transition: auto action→cutscene = whip→crossfade", () => {
  const r = resolveComposeTransition(
    { type: "auto" },
    { query: "combat" },
    { query: "cutscene dialogue" }
  );
  assert.equal(r.intended, "whip");
  assert.equal(r.render, "crossfade");
});

test("transition: auto ingredients→final dish = fade", () => {
  const r = resolveComposeTransition(
    { type: "auto" },
    { query: "ingredient prep" },
    { query: "final dish plating" }
  );
  assert.equal(r.render, "fade");
});

test("categorize: maps known topics", () => {
  assert.equal(categorizeQuery("the combat parts"), "action");
  assert.equal(categorizeQuery("story cutscene"), "dialogue");
  assert.equal(categorizeQuery("funny moments"), "joke");
  assert.equal(categorizeQuery("anything"), "other");
});


// ---------------------------------------------------------------------
// deriveComposeIntent — deterministic multi-source detection (v1.8.1)
// ---------------------------------------------------------------------

import { deriveComposeIntent, findSourceIndex } from "./composeIntent.ts";

const JUNK = ["pick", "first", "second", "third", "transition", "video", "upload"];

test("composeIntent: canonical combat/cutscene prompt → high-confidence compose", () => {
  const r = deriveComposeIntent(
    "pick combat in the first video and the cutscene in the second and make it transition"
  );
  assert.ok(r, "should detect compose");
  assert.equal(r!.confidence, "high");
  assert.equal(r!.plan.sources.length, 2);
  assert.deepEqual(r!.plan.sources[0].sourceRef, { type: "index", index: 0 });
  assert.equal(r!.plan.sources[0].query, "combat moments");
  assert.deepEqual(r!.plan.sources[1].sourceRef, { type: "index", index: 1 });
  assert.equal(r!.plan.sources[1].query, "cutscene moments");
  assert.equal(r!.plan.ordering.type, "source_order");
  assert.equal(r!.plan.transition.type, "auto");
  assert.equal(r!.plan.needsAnalysis, true);
  // No source/ordering/command word leaked into any query.
  for (const s of r!.plan.sources) {
    for (const j of JUNK) {
      assert.ok(!s.query.split(/\s+/).includes(j), `query leaked "${j}": ${s.query}`);
    }
  }
  // Message must not echo raw junk tokens as a topic.
  assert.ok(!/\bpick moments\b|\btransition moments\b|\bfirst moments\b/.test(r!.message), r!.message);
});

test("composeIntent: 'first video should start first then shuffle the rest' → shuffle + anchorFirst", () => {
  const r = deriveComposeIntent("first video should start first then shuffle the rest");
  assert.ok(r);
  assert.equal(r!.plan.ordering.type, "shuffle");
  assert.equal(r!.plan.ordering.anchorFirst, true);
  assert.equal(r!.confidence, "high");
});

test("composeIntent: 'mix combat and cutscene' → interleave compose", () => {
  const r = deriveComposeIntent("mix combat and cutscene");
  assert.ok(r);
  assert.equal(r!.plan.ordering.type, "interleave");
  assert.equal(r!.plan.sources.length, 2);
  assert.equal(r!.plan.sources[0].query, "combat moments");
  assert.equal(r!.plan.sources[1].query, "cutscene moments");
});

test("composeIntent: 'use video 1 for action and video 2 for jokes' → two picks", () => {
  const r = deriveComposeIntent("use video 1 for action and video 2 for jokes, add transition");
  assert.ok(r);
  assert.equal(r!.confidence, "high");
  assert.equal(r!.plan.sources[0].query, "action moments");
  assert.equal(r!.plan.sources[1].query, "jokes moments");
});

test("composeIntent: explicit fade transition is captured", () => {
  const r = deriveComposeIntent(
    "combat from the first video and the cutscene from the second with a fade"
  );
  assert.ok(r);
  assert.equal(r!.plan.transition.type, "fade");
});

test("composeIntent: precision — single-source / merge / edit prompts return null", () => {
  assert.equal(deriveComposeIntent("make a 30s reel of dunks"), null);
  assert.equal(deriveComposeIntent("trim the first 30 seconds"), null);
  assert.equal(deriveComposeIntent("merge the two videos"), null);
  assert.equal(deriveComposeIntent("find the funniest moment"), null);
  assert.equal(deriveComposeIntent("combine the first and second video"), null); // no per-source topics → merge territory
});

test("findSourceIndex: ordinals, video N, bare ordinal; not time ranges", () => {
  assert.equal(findSourceIndex("the first video"), 0);
  assert.equal(findSourceIndex("second upload"), 1);
  assert.equal(findSourceIndex("video 2"), 1);
  assert.equal(findSourceIndex("the cutscene in the second"), 1);
  assert.equal(findSourceIndex("trim the first 30 seconds"), null);
  assert.equal(findSourceIndex("the best parts"), null);
});

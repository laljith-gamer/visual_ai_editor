import { test } from "node:test";
import assert from "node:assert/strict";
import { compileCloudBrief, planCloudAction } from "./cloudBrainRouter.ts";
import type { ChatBrainIntent } from "../llm/chatBrainSchema.ts";

function intent(partial: Partial<ChatBrainIntent>): ChatBrainIntent {
  return {
    route: "create_highlight",
    confidence: 0.9,
    normalizedUserText: "",
    reason: "",
    ...partial
  };
}

// ---- compileCloudBrief --------------------------------------------------

test("compileCloudBrief: folds the model's structured slots into one brief", () => {
  const brief = compileCloudBrief(
    intent({
      normalizedUserText: "pick the best fight scenes from both videos and make a 30s short",
      outputType: "best_moments_reel",
      sourceScope: "all_uploaded",
      targetSeconds: 30,
      includeConcepts: ["fighting", "combat"],
      excludeConcepts: ["cutscene"],
      style: "fast"
    })
  );
  assert.match(brief, /pick the best fight scenes/);
  assert.match(brief, /highlight reel of the best moments/i);
  assert.match(brief, /Use all uploaded videos/i);
  assert.match(brief, /about 30 seconds/i);
  assert.match(brief, /Focus on: fighting, combat/i);
  assert.match(brief, /Avoid: cutscene/i);
  assert.match(brief, /Style: fast/i);
});

test("compileCloudBrief: falls back to contentFocus when no includeConcepts", () => {
  const brief = compileCloudBrief(
    intent({ normalizedUserText: "travel reel", contentFocus: ["beaches", "markets"] })
  );
  assert.match(brief, /Focus on: beaches, markets/i);
});

test("compileCloudBrief: bare text with no slots returns just the text", () => {
  const brief = compileCloudBrief(intent({ normalizedUserText: "make it shorter" }));
  assert.equal(brief, "make it shorter");
});

// ---- planCloudAction ----------------------------------------------------

test("planCloudAction: create_highlight → plan with replace", () => {
  const a = planCloudAction(intent({ route: "create_highlight", normalizedUserText: "x" }));
  assert.equal(a.kind, "plan");
  if (a.kind === "plan") assert.equal(a.replace, true);
});

test("planCloudAction: refine_timeline → plan with replace", () => {
  const a = planCloudAction(intent({ route: "refine_timeline", normalizedUserText: "keep only the fighting" }));
  assert.equal(a.kind, "plan");
  if (a.kind === "plan") assert.equal(a.replace, true);
});

test("planCloudAction: describe_video → describe", () => {
  assert.equal(planCloudAction(intent({ route: "describe_video" })).kind, "describe");
});

test("planCloudAction: ask_clarifying_question with message → ask", () => {
  const a = planCloudAction(intent({ route: "ask_clarifying_question", askMessage: "Which video?", suggestions: ["both"] }));
  assert.equal(a.kind, "ask");
  if (a.kind === "ask") {
    assert.equal(a.message, "Which video?");
    assert.deepEqual(a.suggestions, ["both"]);
  }
});

test("planCloudAction: ask_clarifying_question without message → passthrough", () => {
  assert.equal(planCloudAction(intent({ route: "ask_clarifying_question", askMessage: null })).kind, "passthrough");
});

test("planCloudAction: read_only / confirm / cancel / answer / trim → passthrough", () => {
  for (const route of ["read_only", "confirm_pending", "cancel_pending", "answer_pending_question", "trim_to_target", "passthrough"] as const) {
    assert.equal(planCloudAction(intent({ route })).kind, "passthrough", route);
  }
});

test("planCloudAction: low confidence never overrides the deterministic pipeline", () => {
  assert.equal(planCloudAction(intent({ route: "create_highlight", confidence: 0.3 })).kind, "passthrough");
});

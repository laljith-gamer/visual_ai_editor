# Agentic intake layer — universal vague-request handling (2026-06-19)

> Phase 1 of a universal agentic video-editing intake system. It sits
> BEFORE the existing planner and improves the input sent to it. It does
> NOT replace the planner, remove features, or change unrelated logic.

## Problem

The app expected fairly complete prompts. Real users say vague/messy things
("make this cool", "make a reel", "edit for YouTube", "best moments",
"combine these", "use current video only"). Those produced bad planner
prompts or ugly echoes of the raw text.

## What was added

New layer: **user message → Agentic Intake Router → Edit Brief Builder →
Missing-Info Question Engine → Prompt Compiler → planner → existing pipeline.**

Pure modules under `lib/agentic-intake/` (all unit-tested, no React/store/API):

| File | Purpose |
|------|---------|
| `editBrief.ts` | The universal `EditBrief` type + `createEmptyBrief` + `mergeBrief` (multi-turn; a known value never loses to "unknown"). |
| `capabilityMatrix.ts` | Honest `CAPABILITY_MATRIX` + `classifyEffects` — what the renderer can actually do today. |
| `inferBrief.ts` | `inferBrief` / `finalizeBrief` / `computeMissing`. Reuses `lib/intent/videoPromptInterpreter`. Infers obvious defaults; strips style/scope words from the content focus. NO genre table. |
| `questionEngine.ts` | `decideQuestion` — asks ONE option-chip question at a time in priority order, returning the existing `ClarifyQuestion` shape. |
| `promptCompiler.ts` | `compileBriefPrompt` (clean, structured, capability-honest; never echoes raw text) + `briefSummaryMessage`. |
| `routeDecision.ts` | `decideRoute` → fast_command / vision_briefing / clarify / deterministic / cloud_planner / local_planner / manual_fallback (capability-aware). |
| `intake.ts` | `planIntake` orchestrator → clarify / proceed / passthrough. |
| `runIntake.ts` | Client store adapter — per-session partial brief for multi-turn. The ONLY store-aware piece. |

## Integration (conservative + additive)

- `app/editor/page.tsx` `handleAgent`: intake runs AFTER `tryAgentCommand`,
  BEFORE the quick-shortcut/cloud paths.
  - `clarify` → push the question + `setPendingClarify` (reuses
    `QuickReplies`); return.
  - `proceed` → clear stale clarify + stash the compiled prompt for the
    local-planner fallback; fall through to the unchanged planner path.
  - `passthrough` → do nothing. Fast commands, describe/vision, and any turn
    where a plan already exists (refinements) all pass straight through.
- `lib/local-llm/localPlanner.ts`: `tryLocalPlannerFallback` now accepts an
  optional `ctx.compiledPrompt` and plans from it (vision-honesty guard still
  runs on the original request).

## Honesty / universality guarantees

- No genre/topic table — subject words are treated uniformly across gameplay,
  podcast, cooking, wedding, travel, product, lecture, etc.
- Unsupported effects (slow_zoom, color_grade, text_overlay, captions, audio
  SFX, etc.) are captured as REQUESTS and surfaced honestly; never claimed as
  rendered. The capability matrix is the single source of truth — flip an
  entry there when a real renderer ships (Phase 3).

## Validation

`npm run typecheck` ✓, `npm run build` ✓ (/editor 174 kB; intake is a lazy
chunk), `npm test` = **225 pass / 0 fail** (+27 new in
`lib/agentic-intake/{inferBrief,intake}.test.ts`). Browser/WebGPU + live
planner runtime verification still required (sandbox has neither).

## NOT done (honest scope)

Phase 2 (richer persistent brief beyond the session map) and Phase 3 (real
visual-effect renderer, burned text overlays, audio SFX mixing, capability-
aware render warnings) are future work.

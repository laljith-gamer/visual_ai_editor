# Dynamic progressive local analysis + describe fix (2026-06-20)

> Goal: much faster LOCAL-ONLY responses. Replace the single fixed ~240-frame
> analysis cap with a dynamic, purpose-aware budget, and stop "describe this
> video" from running the full highlight pipeline. Browser-first, no cloud, no
> video upload, keys server-only — all preserved.

## The reported bug

"Describe what's in this video" was interpreted as "I'll look for describe
moments and build a short", then started frame scoring and got stuck. Root
cause: `visual_question` (describe) was classified but then FELL THROUGH the
editor's `handleAgent` to the agent-command/intake/planner path, which treated
"describe" as a content topic and ran the scoring pipeline.

## What changed

### Foundation (pure, unit-tested — `lib/analysis/*`)
- **`types.ts`** — `AnalysisPurpose`, `AnalysisBudget(Input)`, `DeviceTier`,
  `PromptSpecificity`, `VideoAnalysisLevel`, compact `VideoAnalysisMemory`
  (scene map / motion+saliency peaks / good+weak+rejected windows / keyframe
  summaries). NEVER holds raw frames or video bytes.
- **`budget.ts` — `planAnalysisBudget(input)`**: the core. 0 frames for
  exact/read-only/merge/transcript; 5–12 keyframes for quick describe;
  duration-banded best-parts (short 24–80 / normal 80–180 / long 180–360);
  coarse-then-deep for specific visual search (semantic + dense window passes);
  device tier shifts the ceiling within a band; a cached scan drops new work to
  0. A 5s clip never gets 240; a 30-min video gets a deeper (still capped)
  coarse scan.
- **`deviceTier.ts`** — `classifyDeviceTier` (pure) + `detectDeviceTier`
  (hardwareConcurrency / `navigator.deviceMemory` / WebGPU). Coarse, never sent
  to the server, not a fingerprint. Used only to scale the frame ceiling.
- **`purpose.ts` — `classifyAnalysisPurpose(text, ctx)`**: maps a turn to a
  purpose + specificity, reusing the existing pure classifiers
  (`conversationIntent`, `videoPromptInterpreter`). No new phrase table.
- **`videoMemory.ts`** (pure: create/merge/needsLevel/summarize/per-source
  planning summary) **+ `videoMemoryStore.ts`** (browser idb-keyval, keyed by
  `videoHash` so a re-upload reconnects to its memory). Compact only — no raw
  bytes/frames.
- **`clarificationPolicy.ts` — `decideClarification(input)`**: asks ONE focused
  question before deep analysis (multi content type, underfilled target,
  unclear multi-video roles, vague brief, low-confidence quick scan).
- **`globalVideoPlanner.ts` — `planGlobalEdit(sources, request)`**: infers
  source roles/order/strategy from GENERIC signals (clip position, motion
  profile, strong-window count — NO genre table); asks style when unclear;
  balanced mode caps any single source so one video can't dominate unless
  best-first was requested.
- **`lib/timeline/overlapResolver.ts`**: detects same-source overlap
  conflicts; default is ASK (never silent destructive replace); respects
  explicit keep-both; supports skip/replace/keep/trim.
- **`lib/agent/describeResponder.ts`**: honest, INSTANT local describe from
  metadata (+ transcript presence); offers next-step chips; never claims
  on-screen subjects without on-device captioning; never mutates the timeline.

### Wired into the live path
- **Describe fix** — `app/editor/page.tsx` `handleAgent`: the conversation
  guard now also intercepts `visual_question` → `respondDescribe()` (via
  `conversationLane`) → pushes an honest answer + sets `pendingClarify` chips,
  and RETURNS before any planner/pipeline/mutation. Bug fixed.
- **Dynamic frame cap** — `lib/pipeline/executePerSource.ts`: the first-pass
  cap is derived from `planAnalysisBudget` (duration + capability tier),
  replacing the flat `SOURCE_ANALYSIS_MAX_FRAMES = 240`. Backward compatible:
  optional `analysisBudget` arg overrides; absent → duration-aware default; 240
  remains only as a backstop.
- **Config** — `lib/config.ts`: `ANALYSIS`, `DEVICE_TIER`, `CLARIFY_POLICY`,
  `OVERLAP`, `GLOBAL_PLAN` (all thresholds centralized + commented).

## Validation
- `npm run typecheck` ✓
- `npm run build` ✓ (`/editor` first-load 188 kB)
- `npm test` = **397 pass / 0 fail** (+69 new: budget, deviceTier, purpose,
  videoMemory, clarificationPolicy, globalVideoPlanner, overlapResolver,
  describeResponder). New script: `npm run test:analysis`.
- Browser/WebGPU runtime NOT verified (sandbox has no GPU/decode).

## NOT done — honest follow-ups (also in TODO.md)
The budget / video-memory / clarification / global-planner / overlap modules
are BUILT + TESTED but only the describe fix + dynamic frame cap are on the
live path. Remaining wiring (incremental, low-risk):
1. Persist `videoMemoryStore` after a scan and READ it before scanning
   (memory reuse end-to-end + cache-hit budget → 0 new frames).
2. Route the multi-source run through `globalVideoPlanner` (roles/order/shares)
   instead of the flat per-source merge.
3. Gate the add-clip / agent add path through `overlapResolver` (ask on
   ambiguous overlap; respect keep-both).
4. Run an actual bounded quick-scan when the user taps "Run a quick local
   scan" / "deeper local scan" (Level 1–3 progressive passes), writing the
   result into video memory.
5. Surface `decideClarification` after the first quick scan for vague /
   low-confidence creative prompts.

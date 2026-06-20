# Dynamic local analysis — LIVE wiring (2026-06-20)

> Follow-up to `DYNAMIC_LOCAL_ANALYSIS_2026-06-20.md`. That PR built + tested
> the foundation but left most of it foundation-only (only the describe fix +
> dynamic frame cap were live). This PR WIRES the rest into the real editor
> flow so users feel it: quick scan actually scans, video memory persists +
> is reused, multi-video runs use the global planner, overlapping adds ask
> first, and repeat prompts are faster. Browser-first, LOCAL-only, no cloud,
> no upload, no raw frames persisted — all preserved.

## What is now LIVE

### Video memory end-to-end (Objective 1)
- New runtime manager `lib/analysis/videoMemoryManager.ts`: a synchronous
  in-memory `Map<videoHash, VideoAnalysisMemory>` backed by the idb
  `videoMemoryStore`. `primeVideoMemory` (load by hash), `getCachedVideoMemory`
  (sync), `cacheSignalsForHash`, `recordVideoMemory` (merge + persist).
- `app/editor/page.tsx` primes memory for every source hash on upload /
  rehydrate (a useEffect keyed on the joined source-hash list). Memory survives
  refresh / re-upload because it is keyed by content hash.
- `respondDescribe()` (`lib/agent/conversationLane.ts`) now reads the cached
  memory (was hard-coded `null`) → a describe after a scan is richer + honest.
- NO raw bytes / frames are ever cached or persisted — compact derived memory
  only (windows / peaks / scores / structural summary).

### Quick local scan command (Objective 2)
- Pure `lib/analysis/quickScanCommand.ts` (`detectQuickScanCommand`) — anchored
  detection of "Run a quick local scan" / "quick scan" / "scan this video" /
  "scan it" and the deeper variants. Never fires on "scan for the part where…".
- Pure `lib/analysis/quickScanResult.ts` (`summarizeQuickScan`) — reduces the
  per-keyframe motion + saliency (model-free, from the existing canvas pass) to
  a compact level-1 memory patch (motion/saliency peaks, static ranges,
  candidate windows, keyframes) + clarification signals (confidence, candidate
  strength, structural content types). STRUCTURAL only; never fabricates
  captions.
- Browser runner `lib/analysis/quickScan.ts` — samples a bounded keyframe set
  (`planAnalysisBudget`, model-free), summarizes, and persists via
  `recordVideoMemory`. Discards the frame JPEGs.
- `app/editor/page.tsx` `runLocalScanCommand` (a useCallback) is invoked from
  `handleAgent` BEFORE the describe guard. It scans, persists memory, answers
  with `buildDescribeResponse(memory)` + next-step chips, asks one focused
  question only when the scan is low-confidence (`decideClarification`), and
  NEVER creates timeline clips or calls the planner.
- Config: `QUICK_SCAN` block in `lib/config.ts` (all thresholds centralized).

### Purpose + memory-aware budget + persistence (Objectives 3/4/5)
- `runPipeline` classifies the latest user turn with `classifyAnalysisPurpose`,
  detects the device tier once, and per source builds a memory-aware budget via
  `planAnalysisBudget` (real `hasCachedQuickScan` / `hasCachedDeepScan` from
  `cacheSignalsForHash`) which it passes into `executeForSource` (replacing the
  flat-240 default). A memory cache-hit drops the budget toward reuse and shows
  "Using the cached scan from this video…".
  - Guard: when memory says "reuse" (budget 0) the executor is still handed a
    bounded duration-aware cap so a prediction-cache MISS never falls back to
    the flat-240 backstop (the signature-keyed prediction cache does the real
    re-sample skip).
- After the run, `runPipeline` persists a compact `buildHighlightMemoryPatch`
  per source via `recordVideoMemory` (kept clips → knownGoodWindows, top score
  → confidence, semantic pass → level 3 else level 2; weak runs → weakWindows).
  Pure helpers live in `lib/analysis/memorySignals.ts`.

### Clarification (Objective 6)
- `decideClarification` is wired after a quick scan (low-confidence → "scan
  deeper / motion reel?") and in the multi-video planner (style unclear →
  "story style or fast montage?"). Single-video vague creation requests stay
  handled by the existing agentic intake layer (no duplicate system).

### Global multi-video planner (Objective 7)
- The all-sources compose branch (`compose.sourceScope === "all"`) now builds a
  per-source `SourcePlanningSummary` from cached memory, derives the request
  style with `deriveGlobalPlanRequest` (pure; story / montage / best-only — NOT
  a genre table), and calls `planGlobalEdit`. If the brief is genuinely vague it
  ASKS (story vs montage) BEFORE any per-source scan; otherwise it reorders the
  sources by the planned order and sizes each source's contribution by its
  `targetShare` (balanced mode caps any single source so one video can't
  dominate unless best-only was asked).

### Overlap resolver (Objective 8)
- Pure `lib/timeline/overlapIntent.ts` (`parseOverlapResolution`) + pure
  `lib/timeline/overlapFlow.ts` (`detectFirstAddConflict` / `resolveAddConflict`,
  delegating geometry to the tested `applyResolution`).
- `runAgentCommand.applyOps` gates `add_clips` through the resolver: an
  ambiguous same-source overlap PARKS the incoming clip in the new store
  `pendingOverlap` state, asks the user (skip / replace / keep both / trim) via
  `pendingClarify`, and returns handled (no silent stack/replace/skip). An
  explicit instruction in the same turn is honored immediately.
- `handleAgent` resolves a parked overlap when the reply names a resolution
  (snapshotting the timeline via `setHighlights` so undo still works); a
  non-resolution reply abandons the pending overlap and flows on.

### Messaging (Objective 9)
- Honest local-processing copy: scan header ("quick local scan … on-device, no
  cloud"), "Using the cached scan from this video…", structural-only describe
  caveat, overlap question with explicit options.

## Validation
- `npm run typecheck` ✓ (clean, pinned TS 5.6.3 after `npm install`).
- `npm run build` ✓ (`/editor` first load 199 kB, +11 kB).
- `npm test` = **432 pass / 0 fail** (+35 new). `npm run test:analysis` updated
  to include the 6 new pure test files (memorySignals, quickScanResult,
  quickScanCommand, globalPlanRequest, overlapIntent, overlapFlow).
- Browser / WebGPU runtime NOT verified — the sandbox has no GPU/decode. The
  quick-scan canvas sampling, idb persistence, and the multi-video/overlap UX
  still need a real-browser pass (see TODO).

## Honest limits / still foundation-only
- The quick scan + persisted memory are STRUCTURAL (motion/saliency/windows).
  We never claim to name on-screen subjects without on-device captioning.
- Memory reuse reduces the budget + surfaces "Using cached scan", but the
  per-query prediction cache (by signature) remains the mechanism that actually
  skips re-sampling. Cross-query structural reuse (e.g. seeding scoring from
  knownGoodWindows) is a future step.
- `globalVideoPlanner` is wired into the all-sources COMPOSE path only; the flat
  per-source merge in `mergeAcrossSources` is unchanged for non-compose runs.
- `specific_visual_search` / `deep_story` purposes flow through the same
  best-parts budget bands; a dedicated coarse-then-deep two-pass executor is
  future work.

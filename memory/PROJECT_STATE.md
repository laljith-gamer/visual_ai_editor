# PROJECT STATE — Source of Truth

> This file is **authoritative**. When in doubt, trust this file (and the
> code) over any other memory file. Keep it current: update it whenever the
> status, architecture, or "next best step" changes.
>
> Last updated: 2026-06-20 (v2.5 — chat brain preload + dynamic clip durations;
> on a feature branch, not yet merged)

---

## 0. Latest change (2026-06-20) — chat brain preload + dynamic clip durations

Two user-facing wins, both privacy-safe and deterministic-first.

- **Text-only chat brain (fallback only).** A lightweight intent/clarify-answer
  brain is warmed in the background after the editor mounts / first upload
  (`useChatBrainPreload` → `lib/llm/chatBrainPreload.ts` → `app/api/agent/intent`
  `warmup`). It is consulted ONLY when the deterministic
  `resolvePendingAnswer` confidence is below `CHAT_BRAIN.confidenceThreshold`
  (0.72), and a brain answer must clear `minApplyConfidence` (0.6) to apply
  (`lib/agentic-intake/llmPendingAnswerResolver.resolvePendingAnswerWithBrain`).
  PRIVACY BOUNDARY in `lib/llm/chatBrainSchema.ts`: `buildChatBrainPayload`
  sends ONLY compact text state (prev assistant message, the question, the
  field, the typed answer, a few scalar editor facts); `FORBIDDEN_PAYLOAD_KEYS`
  reject any media/frame/blob/path/key. Deterministic commands
  (undo/redo/render/export/trim, yes-no with pending action) NEVER touch it; no
  provider → app stays deterministic silently (`unavailable`, not an error).
  `handleAgent` adds an anti-loop guard: after a usable answer it compiles the
  brief and proceeds rather than re-asking the SAME clarify question
  (`intake.loop.prevented`). Status pill `ChatBrainBadge` in the assistant
  header.
- **Dynamic clip durations.** Clips are no longer a fixed ~3s. New pure
  `lib/pipeline/clipDuration.ts` (`deriveClipDurationBounds` — min ~1s, max
  scales with the source length + target; `clipLengthForScore` — stronger peak →
  longer clip). `tryOfflineBestParts` (`lib/pipeline/highlights.ts`) now uses
  these bounds instead of the flat `max(3, plan.minClipSeconds)` floor, and
  `buildOfflineBestParts` (`lib/pipeline/bestParts.ts`) sizes each clip by its
  score so a reel varies instead of being a row of identical blocks. Guardrails
  in `CLIP_DURATION` config; explicit user min/max still wins.
- **Validation:** typecheck ✓, build ✓ (`/editor` 208 kB; `/api/agent/intent`
  route present), `npm test` = **522 pass / 0 fail** (+30), `test:analysis` =
  104 pass. No cloud media, no upload, no raw frames. Browser/WebGPU +
  live-provider run still pending (no GPU / no key in sandbox). See
  `memory/CHAT_BRAIN_PRELOAD_2026-06-20.md`.

---

## 0. Previous change (2026-06-20) — dynamic free-text chat routing

Fixed the "What should I make?" infinite loop and describe misrouting: the chat
now accepts FREE-TEXT answers to pending questions and progresses the edit brief
instead of repeating the same chip question.

- **Pending-answer resolver** (`lib/agentic-intake/pendingAnswerResolver.ts`):
  new pure module that interprets the user's reply against a pending question
  using exact match → fuzzy → contextual inference (output-type synonyms +
  content extraction + scope). "one continuos" → single_continuous; "travel
  vlog best places" → best-moments reel + content focus.
- **Describe misrouting fix** (`lib/intent/refinementIntent.ts`): describe/
  visual-question text now bails early from `detectRefinement` so "Describe
  what's in this video" doesn't get caught as a scope resolution.
- **HIGHLIGHT_RE expansion** (`lib/agentic-intake/inferBrief.ts`): "best X"
  generically and "pick best" now detected as highlight intent (was limited to
  "best parts/moments/bits/picks").
- **Editing lexicon** (`lib/config.ts`): "continuous" added so "continuos" is
  typo-corrected.
- **Wiring** (`app/editor/page.tsx`): pending-question answer resolution step
  between the editor-turn router and agentic-intake: resolve → re-run intake
  with merged info → proceed or ask NEXT question (not the same one).
- **Tests:** +8 new (`pendingAnswerResolver.test.ts`); total `npm test` = 492
  pass / 0 fail. typecheck ✓, build ✓ (`/editor` 205 kB).
- See `memory/DYNAMIC_LLM_CHAT_ROUTING_2026-06-20.md`. Browser verification
  of the live free-text flows still pending (no GPU/decode in sandbox).

---

## 0. Previous change (2026-06-20) — editor-first turn routing (refinement fix)

Fixed a real failing refinement conversation where the app was planner-first
(vague "find a specific moment" built a 1s short; 120s→37s reported as success;
"remove cutscene / only fighting" ran a NEW append search and dead-ended on
"overlap — nothing to add"; "Removed that clip … Want me to go ahead?" was
self-contradictory; "yes do it" became "look for yes moments"; undo claimed
"nothing to undo"; a single-video refine asked for a second video; "trim to
fit" became a search). The fix is a GENERIC editor-turn routing layer that runs
BEFORE the planner — no hardcoded phrases, no game/entity/genre tables.

- **New pure modules:** `lib/intent/editingNormalize.ts` (generic typo
  correction to an editing lexicon — combact→combat, cutsecene→cutscene),
  `topicPhrases.ts` (preserve content phrase GROUPS, not token soup),
  `targetDurationMemory.ts` (latest explicit duration wins + trim-to-fit
  detection), `refinementIntent.ts` (remove/keep-only/filter/trim/scope),
  `editorTurnIntent.ts` (the router brain), `lib/timeline/trimToTarget.ts`.
- **Router wired into `handleAgent`** before the conversation guard/planner:
  confirm/cancel pending action, trim-to-target, refine/filter (ask first +
  pending action + clean REPLACE on confirm), clarify-missing-moment, scope
  resolution, "render anyway" override; keeps `activeTargetSeconds` in sync.
- **Store:** `pendingAction` (refilter | swap_timeline), `activeTargetSeconds`,
  `trimTimelineToTarget` (snapshots undo).
- **Orchestrator:** low-confidence clarify is no longer self-contradictory and
  never claims an un-performed mutation (undo guarantee).
- **runPipeline:** append overlap offers a one-tap REPLACE instead of a
  dead-end; coverage review runs on append too; weak results → needs_review
  with options; render guard blocks weak/underfilled renders unless "render
  anyway".
- **Tests:** new `test:editor` (52 tests incl. conversation regression).
  typecheck ✓, build ✓ (`/editor` 204 kB), `npm test` = 484 pass / 0 fail.
- See `memory/EDITOR_REFINEMENT_ROUTING_2026-06-20.md`. Browser verification of
  the live refine/trim/swap/render-guard flows still pending.

---

## 0. Previous change (2026-06-20) — dynamic local analysis WIRED LIVE

Wired the dynamic-analysis foundation into the real editor flow (the previous
2026-06-20 PR built + tested it but left most foundation-only). Users now feel
it: the quick-scan chip actually scans, video memory persists + is reused,
multi-video runs use the global planner, overlapping adds ASK first, and repeat
prompts are faster. Still browser-first, LOCAL-only, no cloud, no upload, no raw
frames persisted.

- **Video memory end-to-end:** new runtime `lib/analysis/videoMemoryManager.ts`
  (sync in-memory cache + idb `videoMemoryStore`); editor primes memory by
  source hash on upload/rehydrate; `respondDescribe()` now reads cached memory
  (was `null`). Survives refresh/re-upload by content hash. Compact only.
- **Quick local scan command:** pure `quickScanCommand` (detect) +
  `quickScanResult` (model-free motion/saliency → level-1 memory patch +
  clarification signals) + browser `quickScan` runner (sample → summarize →
  persist). `handleAgent` runs it before the describe guard; it persists memory,
  answers with an honest structural describe + chips, and NEVER creates clips or
  calls the planner. `QUICK_SCAN` config added.
- **Purpose + memory-aware budget + persistence:** `runPipeline` classifies the
  turn (`classifyAnalysisPurpose`), builds a per-source `planAnalysisBudget`
  with REAL cache flags (`cacheSignalsForHash`), passes it to
  `executeForSource` (no more flat-240 default), shows "Using the cached scan",
  and persists a compact `buildHighlightMemoryPatch` per source after the run.
- **Clarification:** `decideClarification` wired after a low-confidence quick
  scan and in the multi-video planner (story vs montage). Single-video vague
  creation stays on the existing intake layer (no duplicate system).
- **Global multi-video planner:** the all-sources compose path builds per-source
  summaries from memory, derives style (`deriveGlobalPlanRequest`), calls
  `planGlobalEdit` → asks (story/montage) when vague, else reorders + sizes each
  source by target share (balanced cap prevents one source dominating).
- **Overlap resolver:** pure `overlapIntent` + `overlapFlow`; `runAgentCommand`
  gates `add_clips` — ambiguous same-source overlap PARKS the clip in the new
  store `pendingOverlap`, asks (skip/replace/keep both/trim), never silently
  stacks/replaces/skips; `handleAgent` applies the reply (snapshots for undo).
- **Validation:** typecheck ✓, build ✓ (`/editor` 199 kB), `npm test` =
  **432 pass / 0 fail** (+35). `npm run test:analysis` extended with 6 new pure
  test files. Browser/WebGPU NOT verified (no GPU/decode in sandbox).
- **Still foundation-only / honest limits:** scan + memory are STRUCTURAL (never
  names on-screen subjects without captioning); cross-query structural reuse and
  a dedicated coarse-then-deep executor are future; the global planner is wired
  into the all-sources COMPOSE path only. See
  `memory/DYNAMIC_LOCAL_ANALYSIS_WIRING_2026-06-20.md`.

---

## 0. Previous change (2026-06-20) — dynamic progressive local analysis + describe fix

Faster, smarter LOCAL responses. Replaced the single fixed ~240-frame cap with
a DYNAMIC, purpose-aware analysis budget, and fixed the bug where "Describe
what's in this video" was misrouted into the build-a-short pipeline and got
stuck in frame scoring. New foundation is pure + unit-tested; integration is
conservative + incremental.

- **New pure modules (`lib/analysis/*`, all tested):** `budget.ts`
  (`planAnalysisBudget` — 0 frames for exact/read-only/merge; 5–12 for quick
  describe; duration-banded best-parts 24–80 / 80–180 / 180–360; coarse→deep
  for specific search; device tier shifts the ceiling; cache → 0 new work),
  `deviceTier.ts`, `purpose.ts` (turn → AnalysisPurpose), `videoMemory.ts`
  (+ `videoMemoryStore.ts` idb-keyval, hash-keyed, NO raw bytes),
  `clarificationPolicy.ts` (ask one focused question before deep analysis),
  `globalVideoPlanner.ts` (multi-video roles/order/strategy, no genre table),
  `types.ts`. Plus `lib/timeline/overlapResolver.ts` (ask-by-default conflict
  resolution) + `lib/agent/describeResponder.ts` (honest instant describe).
- **Describe bug FIXED:** `app/editor/page.tsx` `handleAgent` now intercepts
  `visual_question` (after the read-only guard) → honest local describe answer
  + next-step chips, and RETURNS before any planner/pipeline/mutation path.
- **Dynamic frame cap:** `lib/pipeline/executePerSource.ts` derives the
  first-pass cap from `planAnalysisBudget` (duration + capability tier),
  replacing the flat 240 (kept only as a backstop). Backward compatible.
- **Config:** `ANALYSIS`, `DEVICE_TIER`, `CLARIFY_POLICY`, `OVERLAP`,
  `GLOBAL_PLAN` added to `lib/config.ts` (no magic numbers in logic).
- **Validation:** typecheck ✓, build ✓ (/editor 188 kB), `npm test` =
  **397 pass / 0 fail** (+69). No cloud, no video upload, keys server-only.
- **NOT wired yet (honest):** budget/memory/clarification/global-planner/
  overlap modules are built + tested but only the describe fix + dynamic cap
  are on the live path. Follow-ups: persist+reuse video memory end-to-end,
  route multi-source runs through the global planner, gate add-clip through
  the overlap resolver, run a real bounded quick-scan on the "deeper scan"
  chip. See `memory/DYNAMIC_LOCAL_ANALYSIS_2026-06-20.md`.

---

## 0a. Previous change (2026-06-19) — issue #64 professional video-prompt interpreter

Messy real-user editing prompts no longer fabricate meaning. A new pure
interpreter extracts structured slots BEFORE the specialized detectors run, so
meta/output words can never become content topics.

- **New `lib/intent/videoPromptInterpreter.ts` (pure, tested):**
  `normalizeVideoPromptText` (spelling/spacing only), `parseDuration`,
  `parseClipCount` (min/max/target, guards "5 min"/"clip 5"), `parseFormat`,
  `parsePlatform`, `parseSourceScope`, `META_VOCAB` + `isMeaningfulContentTopic`
  + `extractMeaningfulTopic` (the no-fake-topic guard — NOT a genre table),
  `splitExclusions`. Bounds in `lib/config.ts → VIDEO_PROMPT`.
- **`composeIntent.ts` refactor:** topics come only from
  `extractMeaningfulTopic`; per-source compose preserved; NEW **all-source
  compose** ("select at least 5 clips from all videos … 5 min vertical") →
  `sourceScope:"all"`, `targetSeconds`, `format`, `minClipCount`,
  `genericBestParts`/`allSourcesTopic`, `sources:[]`, clean message.
- **Type + execution:** `MultiSourceComposePlan` extended;
  `composeNormalize` reads the fields (LLM path) and allows empty sources for
  all-scope; `app/editor/page.tsx` fans an all-source compose across EVERY
  eligible upload (cap `VIDEO_PROMPT.maxComposeSources`), splits the duration,
  uses the issue-#62 offline fallback per source, reports underfill honestly,
  and honors `format`/duration at render via `buildComposeOutputPlan`.
- **Validation:** typecheck ✓, build ✓, tests ✓ (198, incl. new interpreter +
  compose #64 cases). Browser run not done (no GPU in sandbox).
- See `ISSUE64_PROFESSIONAL_VIDEO_PROMPT_INTERPRETER_2026-06-19.md`.

---

## 0a. Previous change (2026-06-19) — issue #62 best-picks / target-coverage fix

A 40s "best picks for reels" request used to produce a single 1.0s
low-confidence clip marked "ready to render". Fixed end-to-end on the
default deterministic/offline path (cloud AI is OFF by default):

- **Generic best-parts intent** (`lib/plan/deriveIntent.ts`): generic editing
  words ("best", "picks", "highlights", "make a reel") no longer become SigLIP
  search subjects. New `ActionableIntent.genericBestParts` → focus
  "best moments", scenarioLabels `["visually rich moments"]`, duration
  preserved. Concrete subjects ("best cooking moments") stay subject-driven;
  "make a short" (no duration) stays non-actionable. NOT a genre table — just
  output-vocabulary cleanup.
- **Offline scoring** (`app/api/agent/route.ts`): generic best-parts uses
  `SIGNAL_DEFAULTS.visualInterest` (semantic = 0 → SigLIP skipped; motion +
  saliency). No WebGPU/cloud.
- **CPU/offline fallback** (`lib/pipeline/bestParts.ts`, pure + tested):
  `expandClipRange` + `buildOfflineBestParts` expand short/1s peaks to a useful
  length and spread non-overlapping clips across the source toward the target.
  No fixed clip count. Wired into `lib/pipeline/highlights.ts` as an underfill
  guard for explicit-duration runs.
- **Honest coverage** (`lib/pipeline/coverage.ts`, pure + tested):
  `assessTargetCoverage` flags hard/weak underfill; the editor
  (`app/editor/page.tsx`) then shows an honest "I only found Xs of Ys …"
  message, sets the new `needs_review` status (Topbar/ProjectRail labelled),
  and does NOT say "Tap Render". No-duration runs keep the quality-floor path.
- **Config** (`lib/config.ts`): `TARGET_COVERAGE` + `OFFLINE_BEST_PARTS`
  (all thresholds centralized + commented).
- **Validation:** typecheck ✓, build ✓, tests ✓ (172, incl. new bestParts /
  coverage / deriveIntent cases). Browser run not done (no GPU in sandbox).
- See `ISSUE62_BEST_PICKS_TARGET_FIX_2026-06-19.md` for the full writeup.

---

## 0b. Previous change (2026-06-19) — auto transition picking (issue #57 PR 59 layer)

The editor now AUTO-PICKS the transition between clips from generic media
signals — offline, deterministic, no WebGPU/cloud, NO genre keyword tables.

- **Engine (pure, tested):** `lib/transitions/features.ts` (generic
  signals, graceful degradation), `lib/transitions/auto.ts`
  (`selectAutoTransition`, fixed documented precedence), `lib/transitions/
  timeline.ts` (`buildAutoBoundaryTransitions`, preserves manual, clamps
  duration). Thresholds in `lib/config.ts → TRANSITIONS.autoPick`.
- **Types:** `BoundaryTransition` extended with optional mode/confidence/
  reason/evidence/render/exact/note (backward compatible; PR 58 map tests
  unchanged).
- **Store:** `boundaryTransitions` + setBoundaryTransitions/
  updateBoundaryTransition/resetAutoTransitions/recomputeAutoTransitions;
  editor recomputes on clip sequence change (not on resize drag); manual
  overrides survive. Undo/redo does NOT snapshot transitions (documented).
- **UI:** `components/TransitionsBar.tsx` chip row under the timeline
  (Auto + per-boundary override; honestly shows mapped-down effects).
- **Chat:** `lib/intent/transitionCommands.ts` parsed BEFORE the planner
  ("auto pick transitions", "add fade between clip 1 and 2", "make all
  transitions crossfade", "remove transitions", "faster cuts"); applied in
  `runAgentCommand` with a per-boundary summary reply.
- **Render:** pure `lib/pipeline/renderFilters.ts` (worker delegates to it);
  optional per-boundary `boundaryRenders` threaded through `useFFmpeg` →
  ffmpeg worker + mediabunny; GLOBAL fallback byte-identical when absent.
- **Honesty:** dip_to_black/slide/zoom/glitch/whip/match_cut still map down
  with a note; crossfade renders as a fade dip (true xfade is future).
- **Validation:** typecheck ✓, build ✓, `npm test` = **155 pass** (+36).
  On branch `feat/auto-transitions` — NOT on main yet. See
  `memory/PR59_AUTO_TRANSITIONS_2026-06-19.md`.

---

## 0. Latest change (2026-06-19) — PR 57 production tool reliability (issue #57)

Started issue #57's production-readiness sequence with **PR 57 only**
(kept tight, no risky rewrite). The real gap was EXPORT/download; direct
commands + undo/redo + render wiring already shipped 2026-06-18 and were
verified, not rebuilt.

- **Reliable export.** New `lib/util/download.ts` (pure `buildExportFilename`
  → `shorts-studio-{safe-title}-{yyyyMMdd-HHmmss}.mp4` + browser
  `shareOrDownload` reporting shared/downloaded/blocked/cancelled). New
  `hooks/useExport.ts`; `useShare` refactored onto the shared helper.
  `PreviewToolbar` Export is always visible (no blob → "Render first"),
  shows a status message, and never silently does nothing.
- **Render vs Export split.** `fastCommands.ts` adds an `export` kind
  (export/download/save) distinct from `render` (render/assemble/finish),
  plus a PURE exhaustive `decideFastAction(kind,state)` for testable
  routing. `runAgentCommand.handleFastCommand` uses it; chat "export" →
  `deps.onExport` (→ `useExport`), chat "render" → `deps.onRender`
  (→ real `handleRender`). Editor wires `onExport` via `handleExportRef`.
- **Verified (code-level):** render button and chat render share one path;
  export button and chat export share one path; ClipsDrawer closable +
  remove is undoable; timeline ops snapshot for undo/redo.
- **Tests:** updated `fastCommands.test.ts` (+`decideFastAction`, export
  classification) and new `download.test.ts` → **112 pass / 0 fail**.
  `typecheck` ✓, `build` ✓ (169 kB).
- **NOT done:** browser/manual verification (upload/preview/real download)
  — needs a real browser. PR 58 (transition foundation) is separate. See
  `memory/PR57_PRODUCTION_TOOL_RELIABILITY_2026-06-19.md`.

## 0. Also (2026-06-19) — PR 58 transition foundation (small)

Per-boundary transition MODEL only (no render/UI change yet). `TRANSITIONS`
config guardrails + `lib/transitions/{types,map}.ts`: `TransitionType`
(cut/fade/crossfade/dip_to_black/slide/zoom/glitch/whip/match_cut),
`RenderableTransition` (none/fade/crossfade), `BoundaryTransition`, and an
honest `mapTransition` (exact for cut/fade/crossfade; everything else
mapped down with a note — glitch/whip/match_cut never claimed rendered).
7 mapping tests (→ 119 pass). Render worker + picker UI + chat commands are
the larger follow-up. See `memory/PR58_TRANSITION_FOUNDATION_2026-06-19.md`.

---

## 0. Latest change (2026-06-18) — offline fast-editor pass

Pushes the app toward a fast, offline-first editor brain. Default path is
deterministic + instant; **cloud AI is already OFF by default in code**
(`cloudAiDisabled()` returns true when `DISABLE_CLOUD_AI` is unset — the
older "cloud-primary" notes below are stale; trust the code).

- **Phase 1 — fast command routing (the reported bug fix).** New pure
  `lib/intent/fastCommands.ts` (anchored classifier:
  affirm/cancel/undo/redo/render) runs FIRST in
  `lib/agent/runAgentCommand.ts` `tryAgentCommand`. "yes do it" / "undo" /
  "render" can NEVER become "look for X moments". Priority: pending
  confirm (affirm/cancel WITH pending → existing quick-shortcut gate) →
  undo/redo (always → store) → render (→ real `handleRender`) → affirm/
  cancel with nothing pending (deterministic nudge) → direct commands →
  transcript search → visual fall-through. Added one-step **redo** to the
  store (`redoTimeline`). Direct/control commands resolve <1s, no WebGPU.
- **Phase 2 — offline agent-memory persistence.** New `agentMemory` idb
  store + `lib/agent-memory/persistence.ts`
  (load/save/clear/hydrateAgentMemory) + pure `getRelevantMemory`
  (priority: user_stated > reinforcement > clip > source > flow >
  observed > preference). Hydrated once/session, saved after memory-
  mutating turns. Only the compact serialization is stored — no blobs.
- **Phase 3 — storage budget + manager.** `STORAGE_BUDGET` caps (mobile
  150/50/100 MB, desktop 600/300/500 MB, warn >80 MB) +
  `lib/storage/budget.ts` (pure) + `lib/storage/manager.ts` (measure via
  Cache Storage / idb / `navigator.storage.estimate`; cleanup:
  rendered/frame/transcript/model caches + clear-all). Panel UI not yet
  wired (API ready).
- **Phase 4 — transcription error honesty.** `useTranscription` now sets
  an explicit `phase:"error"` on failure and `TranscriptDrawer` shows
  "Transcription failed: <reason>" instead of silently falling back to
  "No transcript yet".
- **Phase 5 — transcript clipping** already works offline via
  `lib/agent/conceptResolver.ts` (no change needed).
- **Tests:** +16 (`fastCommands`, `memory`, `storage/budget`) → **102
  pass / 0 fail**. `typecheck` + `build` ✓.
- **NOT done (honest):** Phase 6 (cheap CPU best-parts scoring), Phase 7
  (visual-AI enable-prompt), Phase 9 (PWA), the storage PANEL UI, and an
  explicit Tiny/Standard/Vision/Power mode selector. Browser/WebGPU +
  transcription runtime verification still required. See
  `memory/OFFLINE_FAST_EDITOR_2026-06-18.md`.

---

## 0. Latest change (2026-06-17) — agentic intent layer

A net-new deterministic AGENT layer now turns natural editing commands
into structured timeline operations BEFORE the cloud planner, so the app
behaves like an editing assistant rather than a command bot. It is
ADDITIVE and REVERSIBLE: `tryAgentCommand` runs first in `handleAgent`;
on a miss / visual-needed it falls straight through to the unchanged
`tryQuickShortcut` gate and the cloud planner.

- New modules: `lib/intent/{command,timeRangeParser,sourceResolver,
  clipResolver,placementResolver,editCommandParser}.ts`,
  `lib/agent-memory/{types,store,observer,resolver,policy,context}.ts`,
  `lib/timeline/{operations,placement}.ts`,
  `lib/agent/{orchestrator,conceptResolver,reinforcement,runAgentCommand}.ts`,
  `lib/ocr/{types,query}.ts`. New config: `AGENT_POLICY` +
  `AGENT_GUARDRAILS`. See `memory/AGENTIC_INTENT_LAYER_2026-06-17.md`.
- Resolves: which source (one-video assume / named / active-or-last-used
  with surfaced assumption / multi-video clarify), which clip (index/
  first/last/selected/last-created/anaphora/clip-N-from-video-M), which
  time range (first/last/middle N, halves, absolute, before/after,
  relative-to-clip), placement (after/before/between/start/end), and
  append-vs-replace-vs-move-vs-remove. Concept search uses the LOCAL
  transcript first; OCR reports honestly unavailable; generic "best
  parts" defers to the existing visual pipeline with NO fixed clip count.
- Memory: separate user-stated vs observed records, each with confidence
  + evidence; reinforcement (rejected/liked ranges, source preference,
  style hints) influences scoring via `adjustScore`. Confidence policy:
  execute ≥0.85 / execute-with-note ≥0.65 / clarify below.
- "Add" APPENDS (never wipes the timeline); EXACT ranges are kept verbatim
  (never dropped by overlap/cap); undo preserved (ops route through
  `setHighlights`, which snapshots and does NOT re-sort).
- Validation: `npm run typecheck` ✓, `npm run build` ✓ (`/editor` first-
  load 168 kB; agent layer lazy-loaded), `npm test` = **86 pass / 0 fail**
  (36 existing + 50 new). **Browser/WebGPU + transcript runtime
  verification still required** (sandbox has neither).

---

## 1. Project name

**Shorts Studio** (`shorts-studio`) — Universal Video Shorts Editor.

## 2. Main goal

Turn long videos into platform-ready short clips **through conversation**.
Browser-first and free-tier friendly: the heavy work (frame sampling,
scoring, rendering) runs **on-device**, and **video bytes never leave the
browser**. The server is only a thin authenticated proxy for LLM
text/JSON calls.

## 3. Current status

> **2026-06-18 correction (trust code):** cloud AI is **disabled by
> default** — `cloudAiDisabled()` in `lib/env.ts` returns `true` unless
> `DISABLE_CLOUD_AI=false`. The "OpenRouter primary" / "cloud-primary"
> phrasing in the historical bullets below describes the optional cloud
> path that only activates when a key is set AND cloud is explicitly
> enabled. The default runtime path is offline/deterministic.

- Version: **1.7.9** (see `package.json`).
- Latest validation: `npm install` + `npm run typecheck` + `npm run build`
  all pass. (`npm run lint` is not separately configured — `next lint`
  prompts for interactive setup; the build runs its own type/lint pass.)
- **CI (GitHub Actions) is now in place** — `.github/workflows/ci.yml` runs
  `npm run typecheck` + `npm run build` on every PR to `main` and every push
  to `main` (Ubuntu, Node 20, npm cache). Lint is intentionally excluded
  (no ESLint config; `next lint` is interactive). **Browser/WebGPU runtime
  verification is still manual and still required** — CI cannot exercise it.
- Core conversational editing pipeline is working: plan → sample → score →
  detect windows → verify → assemble → render.
- **Multi-source COMPOSE (montage) mode is DONE — Option A (2026-06-13).**
  A new `compose` intent combines per-source semantic picks across MORE THAN
  ONE upload into a fresh ordered montage ("combat in the first video and the
  cutscene in the second, make it transition"). It is distinct from `merge`
  (whole videos) and `plan` (one score-fused reel). Option A lays the montage
  on the single shared `highlights` timeline via `setHighlights` (snapshots
  the prior timeline → one-tap undo); uploads stay immutable; source order is
  preserved unless shuffle/interleave is asked; the run is labelled
  "AI Combined N". Per-source picks run the REAL `executeForSource` pipeline
  (no faked vision). Transitions accept a rich vocabulary but map down to the
  renderable none/fade/crossfade (the client says when it did). Pure logic in
  `lib/plan/compose{Normalize,Resolve,Order,Transition,SubPlan}.ts`
  (unit-tested via `npm run test:compose`); server broker in
  `app/api/agent/route.ts`; client execution + planner `## compose` section.
  **Compose SELECTION is now deterministic (2026-06-13):** a high-precision
  `deriveComposeIntent` (`lib/plan/composeIntent.ts`) detects multi-source
  montage requests from the text and takes PRIORITY over the cloud planner +
  the generic single-source fallback (order: explicit compose -> cloud
  compose -> normal plan -> generic intent -> clarify), wired into a
  priority-override plus the planner-failure/clarify/plan-fail sites. Fixed
  the runtime bug where "combat in the first video and cutscene in the second"
  fell into a junk single-source plan + vague "Decoding error". Client now
  requires >=2 sources and reports per-source decode failures without touching
  the timeline.
  **Option B (a true second timeline slot) is deferred** — see TODO. Browser/
  GPU + live-API verification of the per-source run is still manual.
- Active line of work (2026-06-11): **removed the in-browser WebLLM
  local-first path** and moved language/tool routing **server-side to
  OpenRouter**, with Gemini/Groq kept as fallbacks. The app is **no longer
  offline / local-LLM** as its PRIMARY path, and there is no in-browser model
  download on the cloud path.
- Update (2026-06-13): an **OPTIONAL, opt-in WebLLM local planner** was
  re-introduced as a degraded **fallback only** (cloud → local → manual),
  gated by `NEXT_PUBLIC_LOCAL_LLM_ENABLED` / `_AUTO_FALLBACK` /
  `_DEFAULT_MODEL` (all OFF by default) + WebGPU. It is **text-only** (edit
  planning; NO vision), **lazy-loaded** (never on page load), and fully
  on-device. The cloud path remains primary and unchanged; the manual editor
  works with AI fully off. See `lib/local-llm/*`, `components/AIModeBadge.tsx`,
  and the tier-2 recovery in `handleAgent` (`app/editor/page.tsx`).
- **Cloud model routing** goes through a provider dispatcher
  (`lib/providers/cloud.ts`) in the order **OpenRouter → Gemini → Groq**
  (`CLOUD_PROVIDER_ORDER`): the first provider with a configured key wins,
  a failure falls back to the next, and each provider's circuit breaker is
  recorded independently. Groq is text-only (skipped for vision). The
  dispatcher also **skips circuit-open providers** (`attemptableOrder`) and
  tries the next one — so an OpenRouter outage reroutes to Gemini/Groq rather
  than 503-ing. The route-level circuit pre-check (`checkAllLimits`) is
  **opt-in** (only the single-provider Gemini-direct routes pass `provider`);
  session + global-budget limits still apply to every route. The order can
  also be overridden/toggled at deploy time via the server-only
  `CLOUD_PROVIDER_ORDER` env var (e.g. `gemini` = Gemini only, `openrouter` =
  OpenRouter only); unset → the config default above.
    - `/api/agent` planner JSON uses `cloudPlannerJson`; `normalizePlan` and
      every mode (clarify/briefing/promote/extract/edit/merge/describe) are
      unchanged.
    - `/api/agent/briefing` + `/api/vision/clip` use `cloudVisionJson`
      (OpenRouter multimodal → direct Gemini). OpenRouter handles vision only
      when its configured model is multimodal (default
      `google/gemini-2.5-flash` is); otherwise it falls back to Gemini. No
      fake frame/caption/vision data. (`/api/vision/frame` + `/api/vision/window`
      still use Gemini direct — intentionally out of scope this change.)
- **Security:** the OpenRouter key is **server-only** (`OPENROUTER_API_KEY`,
  read in `lib/env.ts`); there is **no** `NEXT_PUBLIC_OPENROUTER_API_KEY`;
  the key name + endpoint are verified absent from the client bundle.
  Providers never log the key, prompts, or base64 frames. Full video bytes
  never leave the browser — only the already-sampled frames go to the cloud
  vision routes.
- **Deterministic, non-model client paths remain intact:** structured
  briefing follow-ups (`lib/briefing/followups.ts`,
  `hooks/useBriefingActions.ts`), the grammar quick-shortcut gate
  (`lib/intent/*`), and promote/extract/reset via the cloud planner's modes
  + their existing client handlers.
- **Structured briefing follow-ups are DONE (Phase 3).** Briefing chips now
  carry intent via a `BriefingFollowUp` union and run deterministically
  (promote/plan_topic/extract_range) or via chat — no more raw-text
  round-trip to the planner and no "what should the short be about?" loop.
  Multi-source safe: a `plan_topic` chip locks its plan to the briefing's
  `sourceId` so the run stays on the source that was briefed.
- **Agentic clarify (2026-06-13).** Imperfect-but-clear prompts no longer
  dead-end on the old static "what should the short be about?". The planner
  prompt now interprets short/broken requests (a content focus, a parsed
  duration, or an "only/alone" scope makes a turn actionable → plan, not
  clarify). A deterministic safety net in `app/api/agent/route.ts` uses
  `deriveActionableIntent` (`lib/plan/deriveIntent.ts`) + `synthesizeVaguePlan`
  to PROCEED when the LLM fails, applying the parsed duration/focus/exclusions/
  format; the only remaining clarify is a context-aware `dynamicClarifyMessage`
  (upload-first when no source). e.g. "i need a ingredient part alone for 1min"
  → 60s ingredient-only plan. This deterministic text parsing is a documented
  fallback-only exception to the "no keyword heuristics on the server" rule.
  - **Extended (2026-06-13):** the same `deriveActionableIntent` now ALSO runs
    in the `cloudPlannerJson` **catch** path, so a 504/503/timeout no longer
    kills the turn (actionable prompts still produce a plan). It normalizes
    typos (ingrdient→ingredient), drops looking/person stopwords, and emits
    clean `scenarioLabels` so the "Looking for" list never echoes raw broken
    text. Actionable direct-command plans set `autoRun` so the client runs the
    pipeline immediately (no "Run analysis" click) when a video exists.
    Covered by `npm run test:intent` (Node built-in runner, no new dep).
- **Phase 5 has STARTED (one extraction only).** The briefing follow-up
  handler now lives in `hooks/useBriefingActions.ts` (behavior-identical);
  `app/editor/page.tsx` calls it. The remaining hook extractions
  (`useAgentPlanner` / `useTimelineCommandRunner` / `usePipelineRunner` /
  `useAssistantController`) are NOT done — do them one at a time, only when
  touching related code.
- **Still library-only / not wired:** `lib/vision-core/`, `lib/frame-tree/`,
  `lib/vision/caption*`. These need REAL sampled/captioned frame data before
  the local router should execute `plan`/`describe` locally (deliberately
  deferred — see Next best step).
- **Briefing endpoint is resilient to bad JSON (2026-06-11).**
  `/api/agent/briefing` now retries ONCE with fewer frames + a stricter
  compact prompt when the first Gemini response can't be parsed, and falls
  back to a minimal 200 `BriefingResult` (overview + "Try a smaller window" /
  "Pick the best parts for me" chips) if the retry also fails — so
  "Describe what's in this video" no longer dead-ends on *"The video summary
  came back incomplete…"*. A hard error is returned only when the first
  Gemini call fails or the request is invalid.
- **No open PRs blocking** at time of writing.

> Update this section as PRs merge and features ship.

## 4. Current architecture

High level:

```
Upload video (stays in the browser)
  → User chats: "make a 30s reel of the best moments"
  → Planner (server → OpenRouter → Gemini → Groq) returns a structured EditPlan
  → Browser samples frames (mediabunny) + computes motion/saliency
  → Scores frames (SigLIP via WebGPU; motion+saliency when semantic=0)
  → Groups high-score frames into candidate windows
  → Verifies windows via a contact-sheet image (server → Gemini keep/skip)
  → Assembles highlights → renders MP4 (ffmpeg.wasm in a Web Worker)
  → Preview / share / download
```

- **Framework:** Next.js 15 (App Router) + React 19 + TypeScript.
- **In-browser AI:** `@huggingface/transformers` (SigLIP, Whisper) on WebGPU.
- **Rendering:** `@ffmpeg/ffmpeg` (wasm) in a worker.
- **Server routes:** `app/api/*` — auth (iron-session) + 4-layer rate limit;
  proxy LLM calls only (OpenRouter → Gemini → Groq via
  `lib/providers/cloud.ts`). No video upload.
- **State:** Zustand store (`hooks/useEditorStore.ts`); IndexedDB for
  sessions/cache/logs (never blobs).

### Local-first modules (status as of 2026-06-11)

| Module | Purpose | Status |
|--------|---------|--------|
| `lib/providers/openrouter.ts` + `lib/providers/cloud.ts` | Server-side OpenRouter client + provider-order dispatcher (OpenRouter → Gemini → Groq) for language/tool routing + vision | **LIVE (server-side)** |
| `lib/llm/` (WebLLM engine/chat/tools/grounding) + `localFirst.ts` | Browser WebLLM language + tool router | **REMOVED (2026-06-11)** — replaced by server-side OpenRouter |
| `lib/briefing/followups.ts` | Pure normalizer: legacy/string briefing follow-ups → structured `BriefingFollowUp` actions | **LIVE** |
| `hooks/useBriefingActions.ts` | Phase 5 extraction: deterministic briefing follow-up handler (promote/plan_topic/extract_range) pulled out of `app/editor/page.tsx`, behavior-identical | **LIVE** |
| `lib/vision-core/` | Offline deterministic reasoning engine (segments, scoring, sentiment) | **MERGED to main**; not wired |
| `lib/frame-tree/` | In-browser frame organization tree (frames→shots→scenes→chapters) | **MERGED to main** (#29); not wired |
| `lib/vision/caption*` | Optional in-browser frame captioning (Florence-2 / ViT-GPT2) | **MERGED to main** (#30); not wired |
| `lib/pipeline/temporal.ts` range fix | Contact-sheet verification was dead for non-opening windows | **MERGED to main** (#28) |
| `app/api/agent/route.ts` briefing fallback | Briefing follow-up chips no longer hit generic clarify | **MERGED to main** (#33 + clarify-guard follow-up) |

> "Wired into UI" = an end-to-end path in the assistant panel actually
> calls these. The browser WebLLM layer was **removed**; language/tool
> routing is now **server-side** (OpenRouter → Gemini → Groq via
> `lib/providers/cloud.ts`). `vision-core` / `frame-tree` / captioning
> remain library-only until real frame data feeds them.

## 5. Important files / folders

- `app/api/agent/route.ts` — main planner endpoint (intent → mode dispatch).
- `app/api/agent/briefing/route.ts` — whole-video briefing.
- `lib/plan/prompt.ts` — planner system prompt + user-prompt builder.
- `lib/plan/normalize.ts` — validates/normalizes LLM plans into `EditPlan`.
- `lib/pipeline/*` — sample, score, events, temporal, highlights, render.
- `lib/vision/*` — SigLIP worker, contact sheet, (new) captioning.
- `lib/providers/*` — OpenRouter + Gemini + Groq clients, plus the
  `cloud.ts` provider-order dispatcher (the single place provider preference
  is decided).
- `lib/config.ts` — all tunable constants + CSP.
- `lib/types.ts` — central domain types (`EditPlan`, `AgentResponse`, etc.).
- `hooks/useEditorStore.ts` — client source of truth (Zustand).
- `components/*` — editor UI (timeline, drawers, assistant panel).

## 6. Current problems / known issues

> Keep this list honest and current. Remove items when fixed.

- The deeper local-first modules (`lib/vision-core/`, `lib/frame-tree/`,
  `lib/vision/caption*`) are **merged but not wired** — they were built to
  ground a local router that has since been **removed**. They remain
  available for future use (e.g. enriching the server planner with
  client-computed frame context) but are not on any live path. Do not fake
  frame data to wire them.
- **Deploy lag:** fixes merged to `main` (e.g. the briefing "invalid JSON"
  fix) won't appear in the running app until it is rebuilt/redeployed.
- **Runtime verification gap:** WebGPU features (SigLIP / Whisper /
  captioning) and live OpenRouter/Gemini calls cannot be verified in a
  headless/CI sandbox — they need a real browser + GPU and real API keys.
  Typecheck + unit-level checks only go so far.
- Sandbox/CI may have **no `node_modules` by default** — run `npm install`
  before trusting a typecheck (otherwise bare-import type errors are hidden).
- **OpenRouter `max_tokens` has tiered safety caps (2026-06-13, tightened).**
  Omitting `max_tokens` made OpenRouter reserve the model's full output window
  and 402 low-credit accounts. `lib/config.ts` OPENROUTER now defines
  `plannerMaxTokens` (1200), `visionMaxTokens` (1600) and an absolute
  `hardMaxTokens` ceiling (2048, env `OPENROUTER_MAX_TOKENS`).
  `attemptCompletion` ALWAYS clamps to the ceiling, so 65535 can never be sent
  (even the briefing's 3072 retry clamps to 2048). Raise the env knob only if
  a turn truncates.
- **OpenRouter retries transient overloads (2026-06-13).** The client retries
  429/5xx/network/"overloaded" errors with backoff
  (`OPENROUTER.retryAttempts=3`, `retryBaseDelayMs=600`), mirroring Gemini.
  This is the PRIMARY fix for the temporary "vision model is temporarily
  overloaded" message; non-transient (incl. 402) and aborted requests are not
  retried. NOTE: this retry was lost when PR #48 merged the token-cap commit
  only (the retry commit landed post-merge); it was re-applied on
  `feat/openrouter-token-caps`.

## 7. Next best step

- **Manual browser test the agentic intent layer (2026-06-17).** With a
  video uploaded: "add first 2 min", "add last 30 sec from video 2 after
  clip 3", "remove clip 2", "move clip 3 before clip 1", "replace clip 1
  with 0:30 to 0:45", "add the part where he says subscribe" (needs a
  local transcript), "the screen where it says SALE" (must say OCR isn't
  ready, not fake it), "pick best parts" (no fixed count), "not this, more
  like clip 2". Confirm: append (not wipe), exact ranges kept, undo works,
  assumptions surfaced, multi-video ambiguity asks. Needs a real WebGPU
  browser + a transcript; the sandbox has neither.
- **Optional: route the agent's `needs_visual` decision straight into the
  in-browser pipeline** (build a scenario plan from the resolved source +
  reinforcement and run `executeForSource` with `adjustScore`), instead of
  falling through to the cloud planner. The pieces are ready.

- **Validate OpenRouter end-to-end in a real deployment.** Set
  `OPENROUTER_API_KEY` and confirm: `/api/agent` returns valid planner JSON;
  "Describe what's in this video" works via OpenRouter multimodal (default
  `google/gemini-2.5-flash`); structured briefing chips +
  promote/extract/reset still work; and with the key unset (or on a forced
  failure) the flow falls back to direct Gemini/Groq. Confirm in the browser
  Network tab that there is no model download and the key never appears
  client-side.
- **Optional: extend OpenRouter to the remaining vision routes.**
  `/api/vision/frame` + `/api/vision/window` still call Gemini directly; they
  could route through `cloudVisionJson` for consistency (intentionally left
  out of this change to keep scope tight).
- **Optional: enrich the server planner with client frame context.** Now that
  routing is server-side, `lib/frame-tree/` + `lib/vision/caption*` outputs
  could be summarised and passed into the planner prompt (text only, never
  fake) to improve grounding — a future enhancement, not required.
- **Phase 5 (maintainability, IN PROGRESS — 1 of ~5 done):**
  `app/editor/page.tsx` is large. First extraction shipped:
  `hooks/useBriefingActions.ts`. Continue ONE hook at a time, only when
  touching related code and strictly behavior-identical — next candidates:
  `useAgentPlanner`, `useTimelineCommandRunner`, `usePipelineRunner`,
  `useAssistantController`. Do not mix with feature work; no big rewrite.
- **Browser/GPU + live-API verification** of the cloud chat/vision path and
  the on-device SigLIP/Whisper/captioning features is still pending — needs a
  real WebGPU browser and real API keys; the sandbox has neither.

> Replace this with the actual next step whenever it changes.

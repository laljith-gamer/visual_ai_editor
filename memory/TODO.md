# TODO

> Prioritized, actionable task list. Keep it short and current — move done
> items to **Completed** (and reflect notable ones in `CHANGELOG.md`).
> Larger directional items live in `ROADMAP.md`.
>
> Last updated: 2026-06-11 (documented OpenRouter-only pin → openai/gpt-5.5-pro, no fallback)

## High priority

- [ ] **Manual browser test — chat brain preload + dynamic clips (2026-06-20,
      v2.5).** Needs a real browser + a configured provider key (no GPU/decode
      and no provider in sandbox). Verify:
      1. With a provider key set, the `ChatBrainBadge` goes idle → warming →
         ready shortly after the editor loads / first upload; with NO key it
         shows "unavailable" and the app still works deterministically.
      2. A clearly-typed clarify answer resolves WITHOUT consulting the brain
         (deterministic-first); only an ambiguous free-text answer triggers the
         LLM fallback (`intent.llm.used`); a usable answer NEVER re-asks the
         same question (`intake.loop.prevented`).
      3. Deterministic commands (undo/redo/render/export/trim, yes/no with a
         pending action) never call the brain and stay instant.
      4. Network panel: the `/api/agent/intent` request body contains ONLY
         compact text (no frames/blobs/paths/keys).
      5. A reel from a long video produces clips of VARYING length (some ~1s,
         some longer), not a row of identical ~3s blocks; a short video can
         yield ~1s clips; an explicit min/max is still honored.
      See `memory/CHAT_BRAIN_PRELOAD_2026-06-20.md`.

- [ ] **Manual browser test — free-text chat routing (2026-06-20).** Verify:
      1. "Describe what's in this video" → describe response, NOT "What should
         I do with it?"
      2. "he is a traveller pick best visits" → infers highlight reel +
         content focus (travel/visits); asks NEXT question (duration), NOT
         "What should I make?" again.
      3. "best places here" → updates content focus, does not loop.
      4. "one continuos" → typo fixed, output_type resolved to
         single_continuous, proceeds.
      5. No pending-question loop when user types naturally instead of chips.
      See `memory/DYNAMIC_LLM_CHAT_ROUTING_2026-06-20.md`.

- [ ] **Manual browser test — editor-first refinement routing (2026-06-20,
      after deploy).** Needs a real browser. Verify the live flows the unit
      tests can't cover:
      1. "Find a specific moment" (no subject) → asks which moment, no clip
         built.
      2. "remove cutscene, only fighting" with clips present → asks first;
         "Yes, do it" re-picks (REPLACE, not append) and "undo" restores.
      3. "remove all boring parts make it 1 min" → refines current video at
         60s; never asks for a second video.
      4. "from current video clips" after a pending refine → proceeds at the
         kept 60s target.
      5. "trim to fit" → trims current timeline to the active target; "undo"
         restores; no planner/search runs.
      6. A 120s request that yields ~37s → needs_review (not "ready"); plain
         "render" warns; "render anyway" proceeds.
      7. New picks that all overlap → one-tap "replace / keep" (no "nothing to
         add" dead-end).
      8. "give me red boy and wukong fight … 2 min" → genuine search, target
         120s, typo "combact" handled.
      See `memory/EDITOR_REFINEMENT_ROUTING_2026-06-20.md`.

- [ ] **Manual browser test — dynamic analysis WIRED (2026-06-20, after
      deploy).** Needs a real browser (no GPU/decode in sandbox). Verify the
      six live behaviours:
      1. "Run a quick local scan" / "scan this video" → a bounded on-device
         scan runs, an honest STRUCTURAL description appears, NO timeline clips
         are created; refresh the page and "describe this video" still recalls
         the scan (memory persisted by hash).
      2. "Pick the best parts" then the SAME ask again → second run shows
         "Using the cached scan from this video" and samples fewer/no new
         frames; a 10s vs 30-min video samples far fewer frames on the short.
      3. "Add first 30 seconds" → instant, no scan, under 1s.
      4. Add a clip overlapping an existing same-source clip → it ASKS
         (skip/replace/keep both/trim); "keep both" / "replace the old one" /
         "trim overlap" each apply correctly and undo restores; nothing is
         silently dropped/replaced.
      5. Multi-video "make a cinematic story from all videos" → story order;
         "make it cool from all videos" → asks story vs montage BEFORE scanning;
         "make a reel from all videos" → balanced, no single source dominates.
      6. Low-confidence quick scan → offers "scan deeper / motion reel".
      See `memory/DYNAMIC_LOCAL_ANALYSIS_WIRING_2026-06-20.md`.

- [ ] **Follow-up — deeper dynamic-analysis reuse (next).** (a) Seed scoring /
      window detection from `knownGoodWindows` so a cached structural scan
      reduces work for a DIFFERENT query (today reuse mainly helps describe +
      the same-signature prediction cache). (b) Route NON-compose multi-source
      runs through `globalVideoPlanner` too (currently the all-sources compose
      path only; `mergeAcrossSources` is otherwise unchanged). (c) A dedicated
      coarse-then-deep two-pass executor for `specific_visual_search` /
      `deep_story` (they currently use the best-parts budget bands).

- [ ] **Manual browser test — issue #64 messy compose prompts (after deploy).**
      Upload 2–3 videos, ask `atleast sect 5 clip from all and make it as
      combined 5 min video vertical`: clean message (no "atleast sect all" /
      "min vertical" / fake first/second), source scope all, target 5 min,
      vertical, ≥5 clips if possible. Verify `pick combat in first and cutscene
      in second` per-source compose, `make a 40 sec reel of cooking shots`
      single-source, `remove clip 5` direct edit, `select 5 clips from all`
      count-not-index. See `ISSUE64_PROFESSIONAL_VIDEO_PROMPT_INTERPRETER_2026-06-19.md`.
      (No GPU/decode in sandbox — not run here.)
- [ ] **Follow-up — feed compose exclusions into sub-plans (issue #64).**
      `splitExclusions` records "avoid X" and shows it in the message but the
      excluded subject isn't yet threaded into the per-source `avoid` list.
- [ ] **Follow-up — unify routing on the interpreter (issue #64).**
      `classifyVideoPromptIntent`-style full routing (control/question/exact_edit/
      …) was scoped down; the interpreter currently powers compose only. A later
      pass can route the fast-command / edit / question detectors through it.

- [ ] **Manual browser test — issue #62 best-picks / target-coverage (after
      deploy).** Upload a long video, ask `make a best picks for reels for
      40 sec`: chat must NOT say "best and picks moments"; target = 40s;
      output is NOT a single 1s clip; if confidence is low the UI explains it
      and status shows "needs review" (not "ready to render") when badly
      underfilled; render is not pushed as ready; transitions only with 2+
      clips; no cloud/WebGPU needed for the CPU fallback. See
      `ISSUE62_BEST_PICKS_TARGET_FIX_2026-06-19.md`. (No GPU/decode in
      sandbox — not run here.)
- [ ] **Follow-up — events.ts window sizing (issue #62).** Single-frame
      candidate windows are sized by `plan.sampleEverySeconds` (1.0s) even
      when adaptive sampling spaces frames ~5s apart. The offline expansion
      masks this for explicit-duration asks; the underlying window sizing was
      left unchanged (out of scope). Consider sizing windows by the actual
      adaptive step.
- [ ] **Transitions — true crossfade + real effects (next PR).** Auto
      picking + per-boundary render landed (PR 59). Still TODO: render a
      TRUE overlap crossfade via ffmpeg `xfade` + mediabunny cross-dissolve
      (today crossfade = a fade dip, same as fade); then implement real
      dip_to_black / slide / zoom so they stop mapping down. Also consider
      including `boundaryTransitions` in the undo/redo snapshot (currently
      they recompute after undo and manual overrides aren't restored).
- [ ] **Manual browser test — auto transitions (PR 59, after deploy).**
      Upload a video, add 3 clips → the Transitions chip row shows auto
      picks (e.g. "Auto: Cut"); change one to Crossfade; move/remove a clip
      and confirm the row updates and the manual override survives; run
      "auto pick transitions" in chat and confirm it lists picks + reasons;
      render with cut/fade/crossfade and export; pick Zoom/Glitch and verify
      it shows "→ crossfade (mapped)" and renders as that; confirm no
      WebGPU/cloud is needed. (Sandbox has no GPU/decode — not run here.)
- [ ] **Manual browser test — PR 57 export/upload/preview (after deploy).**
      Upload MP4/MOV/WebM → clear success/failure, no broken state on
      failure, duplicate handled. Source preview after upload; combined
      preview after render; clips drawer opens/closes. Render (button and
      chat "render") → same path, progress shown, readable error. Export
      (button and chat "export") → downloads `shorts-studio-<title>-<ts>.mp4`;
      with no render → "Render first"; if the browser blocks the download →
      fallback guidance shows (never silent). Remove/move/trim → undoable;
      "undo"/"redo" restore. Needs a real browser; not verifiable in CI.

- [ ] **Manual browser test — offline fast-editor (2026-06-18, after deploy).**
      Confirm none of these reach the planner and all resolve <1s:
      "yes do it" (with a pending → runs it; with nothing pending → nudge,
      NOT a search), "undo"/"redo" (timeline restore), "cancel"/"no"
      (clears pending / "nothing to cancel"), "render"/"export" (renders).
      Direct: "add first 5 seconds", "add from 0:10 to 0:20",
      "move clip 1 after clip 2", "remove clip 1". Refresh the page →
      agent flow + reinforcement memory persists (IndexedDB
      `shorts-studio-agent-memory`). Force a transcription failure (e.g.
      audio-less file) → drawer shows "Transcription failed: <reason>",
      NOT a silent "No transcript yet". Needs a real browser; not
      verifiable in CI.
- [ ] **Phase 6 — cheap CPU "best parts" (no WebGPU).** Implement
      motion/scene-cut/audio-energy/silence/blur scoring + transcript
      keyword + reinforcement so "pick best parts" works without a vision
      model. Today it routes to the WebGPU pipeline via `needs_visual`.
- [ ] **Phase 7 — visual-AI enable prompt.** Detect WebGPU + estimate
      model size and ask before downloading; show "visual AI unavailable
      on this device" and continue with CPU/transcript analysis.
- [ ] **Phase 9 — PWA / offline shell.** Cache app shell + core JS/CSS +
      lazy ffmpeg core; tiny transcription model cached only after opt-in;
      no automatic large-model caching; offline status indicator.
- [ ] **Storage panel UI (Phase 3 surface).** Wire `lib/storage/manager.ts`
      (`estimateStorageBreakdown` + cleanup actions) into a debug/settings
      panel showing Models/Frames/Transcripts/Rendered/Total + cleanup
      buttons + over-budget + model-download warnings.

- [ ] **Manual browser test — agentic intent layer (2026-06-17, after deploy).**
      With a video uploaded, verify the deterministic agent handles:
      "add first 2 min", "add last 30 sec from video 2 after clip 3",
      "add the middle part", "add from 1:20 to 2:10", "add clip 2 after
      clip 5", "move clip 3 before clip 1", "replace clip 4 with 0:30 to
      0:45", "remove this", "extend clip 1 by 3 seconds", "trim clip 2 to
      0:05-0:10", "render". Concept: "add the part where he says
      subscribe" (needs a local transcript → transcript-grounded clip);
      "add the screen where it says SALE" (must say OCR isn't ready and
      fall back — never fake it); "pick best parts" / "pick best cooking
      parts" (no fixed clip count). Reinforcement: "not this, more like
      clip 2", "use video 1 only", "this is perfect". Single video →
      assumed automatically; multi-video unnamed → uses active/last-used
      with a surfaced assumption OR asks when truly ambiguous. Confirm:
      "add" APPENDS (never wipes), exact ranges kept verbatim, undo works,
      assumptions shown in chat, evidence label shown ("transcript match"
      / "exact range"). NEEDS a real WebGPU browser + a transcript — not
      verifiable in CI/sandbox.

- [ ] **Manual test — compose SELECTION + decode errors (browser, after deploy).**
      With 2+ uploads: "pick combat in the first video and the cutscene in the
      second and make it transition" → mode=compose (NOT a single-source plan,
      NO "pick/first/transition moments" message), montage in source order
      with transitions. "first video should start first then shuffle the rest"
      → shuffle + anchorFirst. "mix combat and cutscene" → interleave. With
      only ONE upload → context-aware "upload/select a second video" ask (never
      "what should the short be about?"). Feed a non-H.264 / broken second
      video → message names the second video + says the previous timeline was
      not changed (timeline must be intact). Needs a real WebGPU browser + keys.

- [ ] **Manual test — multi-source compose / montage (browser, run after deploy).**
      Upload 2+ videos. Try: (1) "pick combat in the first video and the
      cutscene in the second and make it transition" → mode=compose, a fresh
      montage on the timeline, source order (combat clips then cutscene
      clips), transitions applied, prior timeline restorable via "undo".
      (2) "first video should start first then shuffle the rest" → lead clip
      pinned, rest shuffled. (3) "mix combat and cutscene" → interleaved.
      (4) "intro from first, funny part from second, ending from third" →
      3 sources, story-ish order. Confirm: original uploads untouched; the
      assistant names the run ("AI Combined 1"); if a fancy transition
      (glitch/whip) is asked, the summary admits it rendered the closest real
      one; per-source picks come from the REAL vision pipeline (not faked).
      NOTE: needs a real WebGPU browser + API keys — not verifiable in CI.

- [ ] **(Future / Option B) True second timeline slot for compose.** Today
      compose REPLACES the single shared timeline (undo-recoverable). A real
      multi-slot model (montage coexisting beside the working reel) needs new
      store state (`composedTimelines[]` or tagged groups) + `Timeline.tsx`,
      render-worker, and session-persistence changes. Plan as its own
      timeline-architecture task before building.

- [ ] **Manual test — IndexedDB self-healing (browser).** (1) Load app so DBs
      are created. (2) In DevTools → Application → IndexedDB, corrupt a DB
      (delete the `kv` store, or temporarily rename `storeName` in code, load
      once, restore). (3) Reload. Confirm: NO "Failed to execute 'transaction'
      on 'IDBDatabase'" crash; the affected DB is deleted/recreated (one
      `console.warn: Recovered IndexedDB store: <db> during <op>`);
      sessions/cache/logging still work; no video/base64/API-key data in
      logs; if recovery can't complete, the clean "Local browser storage was
      corrupted…" message shows (not raw IDB text). Emergency reset:
      `["shorts-studio-sessions","shorts-studio-cache","shorts-studio-logs","shorts-studio-transcripts"].forEach(n=>indexedDB.deleteDatabase(n));location.reload();`

- [ ] **Manual test — dynamic duration (run after deploy).** Verify each case:
      1. "make best moments" → mode=plan, `userSpecifiedDuration=false`, no
         fixed target, chat/PlanPreview never say "30s", length emerges from
         clip quality.
      2. "make a 30 second reel" → `userSpecifiedDuration=true`,
         `targetShortSeconds=30`, budgeted fit runs.
      3. "make it 15s" → `userSpecifiedDuration=true`, `targetShortSeconds=15`.
      4. "make a 1 minute highlight" → true, 60.
      5. After briefing, "clip those" → mode=promote, NO `targetSeconds`,
         natural clip lengths preserved.
      6. "make a 15s reel of these" → mode=promote, `targetSeconds=15`.
      7. "make a YouTube Short from this" → vertical format OK,
         `userSpecifiedDuration=false`, no default 30s.
      8. Memory with explicit prior 45s preference may apply (true/45) only
         when clearly relevant; otherwise don't assume.
- [ ] **Validate OpenRouter end-to-end (real deployment).** With
      `OPENROUTER_API_KEY` set: `/api/agent` returns valid planner JSON;
      multimodal briefing / "describe" works (default
      `google/gemini-2.5-flash`); briefing chips + promote/extract/reset
      still work; and with the key unset / on failure it falls back to direct
      Gemini/Groq. Confirm no browser model download and the key never
      appears client-side.
- [ ] **Browser/WebGPU + live-API verification.** The cloud chat/vision path
      and on-device SigLIP/Whisper/captioning need a real GPU browser + real
      API keys; not possible in the sandbox.
- [ ] **Redeploy** so the OpenRouter migration reaches the running app. Set
      `OPENROUTER_API_KEY` (and optionally `APP_URL`, `OPENROUTER_*_MODEL`)
      in the deployment environment.

## Medium priority

- [ ] Optionally route `/api/vision/frame` + `/api/vision/window` through the
      `cloudVisionJson` dispatcher too (left out of the OpenRouter migration
      to keep scope tight; they still call Gemini directly).
- [ ] Optionally have `/api/agent/briefing` emit structured `BriefingFollowUp`
      actions directly (client already normalizes strings, so this is a
      quality bump, not a requirement).

## Low priority

- [ ] Expand unit tests for deterministic, non-GPU logic (frame-tree,
      `normalizeBriefingFollowUps`, synthesizeVaguePlan, and the
      `lib/providers/cloud.ts` provider-order selection).
- [ ] Document device-tier expectations (which models run where).
- [ ] **Phase 5 (maintainability) — continue ONE hook at a time.** First
      extraction done (`hooks/useBriefingActions.ts`). Remaining candidates
      from `app/editor/page.tsx`: `useAgentPlanner`,
      `useTimelineCommandRunner`, `usePipelineRunner`,
      `useAssistantController`. Behavior-identical only; not mixed with
      feature work; no big rewrite.

## Completed

- [x] (2026-06-20) **Chat brain preload + dynamic clip durations (v2.5).**
      Privacy-safe TEXT-ONLY intent/clarify-answer brain warmed in the
      background (`lib/llm/{chatBrainSchema,chatBrainPreload}.ts`,
      `app/api/agent/intent/route.ts`, `hooks/useChatBrainPreload.ts`,
      `components/ChatBrainBadge.tsx`); used ONLY as a low-confidence fallback in
      `resolvePendingAnswerWithBrain`; never receives media (only compact text
      via `buildChatBrainPayload` + `FORBIDDEN_PAYLOAD_KEYS`); deterministic
      commands never touch it; anti-loop guard in `handleAgent`. Dynamic clip
      durations (`lib/pipeline/clipDuration.ts` → `deriveClipDurationBounds` +
      `clipLengthForScore`, wired into `bestParts`/`highlights`) replace the
      fixed ~3s. Config: `CHAT_BRAIN` + `CLIP_DURATION`. +30 tests
      (`npm test` = 522). typecheck + build ✓ (`/editor` 208 kB). Browser +
      live-provider run pending. See `memory/CHAT_BRAIN_PRELOAD_2026-06-20.md`.

 New generic
      pre-planner router (`lib/intent/editorTurnIntent` + `refinementIntent` +
      `topicPhrases` + `editingNormalize` + `targetDurationMemory` +
      `lib/timeline/trimToTarget`) so refine/control turns route as editor
      operations, never random searches. Store `pendingAction` +
      `activeTargetSeconds` + `trimTimelineToTarget`; orchestrator clarify
      de-contradicted; deriveIntent typo-normalized; append-overlap swap +
      coverage-on-append + weak→needs_review + render guard. +52 tests
      (`test:editor`), `npm test` = 484. typecheck + build ✓. Browser run
      pending. See `memory/EDITOR_REFINEMENT_ROUTING_2026-06-20.md`.

- [x] (2026-06-20) **Dynamic local analysis — WIRED LIVE.** Quick-scan command
      (`quickScanCommand`/`quickScanResult`/`quickScan`) scans on-device +
      persists level-1 memory + answers honestly, no clips. Video memory
      end-to-end (`videoMemoryManager` sync cache + idb; primed by hash;
      describe reads it). `runPipeline` classifies purpose + builds memory-aware
      `planAnalysisBudget` per source + persists `buildHighlightMemoryPatch` +
      "Using cached scan" copy. `decideClarification` after low-confidence scan
      + multi-video style. `globalVideoPlanner` wired into the all-sources
      compose path (clarify story/montage, balanced shares). Overlap resolver
      gates `add_clips` (`overlapIntent`/`overlapFlow` + store `pendingOverlap`):
      ambiguous → ask, never silent. +35 tests (`npm test` = 432). typecheck +
      build ✓ (`/editor` 199 kB). Browser run still pending. See
      `memory/DYNAMIC_LOCAL_ANALYSIS_WIRING_2026-06-20.md`.


      Offline, deterministic, evidence-based selector (no genre tables):
      `lib/transitions/{features,auto,timeline}.ts` + `TRANSITIONS.autoPick`
      config + extended `BoundaryTransition`. Store `boundaryTransitions`
      + actions + recompute-on-sequence-change. UI `TransitionsBar`. Chat
      `transitionCommands` (before planner). Render: pure `renderFilters.ts`
      + per-boundary `boundaryRenders` threaded through worker + mediabunny
      (global fallback preserved). +36 tests → 155 pass. typecheck+build ✓.
      On branch `feat/auto-transitions`, not yet merged. Honest mapping kept
      for dip_to_black/slide/zoom/glitch/whip/match_cut; crossfade still a
      fade dip (true xfade is the next PR). See
      `memory/PR59_AUTO_TRANSITIONS_2026-06-19.md`.

- [x] (2026-06-19) **PR 58 — per-boundary transition foundation (small).**
      `TRANSITIONS` config guardrails + `lib/transitions/{types,map}.ts`:
      `TransitionType` (cut/fade/crossfade/dip_to_black/slide/zoom/glitch/
      whip/match_cut), `RenderableTransition`, `BoundaryTransition`, honest
      `mapTransition`/`toRenderable`/`describeMappedDowns` (cut/fade/
      crossfade exact; rest mapped down with a note; glitch/whip/match_cut
      never claimed rendered). +7 tests → 119 pass. typecheck + build ✓.
      Render worker + picker UI + chat commands are the larger follow-up.
      See `memory/PR58_TRANSITION_FOUNDATION_2026-06-19.md`.

- [x] (2026-06-19) **PR 57 — production tool reliability (issue #57).**
      Reliable export/download: `lib/util/download.ts` (deterministic
      `shorts-studio-{title}-{yyyyMMdd-HHmmss}.mp4` + `shareOrDownload`
      with blocked/cancelled reporting), `hooks/useExport.ts`, `useShare`
      refactor, `PreviewToolbar` always-visible Export + "Render first" +
      status message. Render-vs-export split in `fastCommands.ts`
      (`export` kind + pure `decideFastAction`); `runAgentCommand` chat
      "export" → `onExport`, "render" → `onRender`; editor wires
      `handleExportRef`. Tests: updated `fastCommands.test.ts` + new
      `download.test.ts` → 112 pass. typecheck + build ✓. Browser manual
      verification still required. See
      `memory/PR57_PRODUCTION_TOOL_RELIABILITY_2026-06-19.md`.

- [x] (2026-06-18) **Offline fast-editor pass (Phases 1–5, 10).** Fast
      command routing (`lib/intent/fastCommands.ts` + `runAgentCommand`
      fast path): affirm/cancel/undo/redo/render never reach the planner,
      correct priority, <1s, no WebGPU. One-step **redo** added to the
      store. Agent-memory IndexedDB persistence (`agentMemory` store +
      `lib/agent-memory/persistence.ts` + pure `getRelevantMemory`
      priority). Storage budget + manager (`lib/storage/{budget,manager}.ts`
      + `STORAGE_BUDGET`). Explicit transcription errors (`useTranscription`
      + `TranscriptDrawer` — no more silent "No transcript yet"). Transcript
      clipping confirmed offline via `conceptResolver`. +16 tests
      (`npm test` = 102 pass). typecheck + build ✓. Phases 6/7/9, storage
      panel UI, and browser runtime verification remain. See
      `memory/OFFLINE_FAST_EDITOR_2026-06-18.md`.

- [x] (2026-06-17) **Agentic intent layer (additive, reversible).** New
      deterministic agent that parses natural editing commands into
      structured timeline operations before the cloud planner:
      `lib/intent/{command,timeRangeParser,sourceResolver,clipResolver,
      placementResolver,editCommandParser}`, `lib/agent-memory/*`
      (confidence+evidence memory, reinforcement, confidence policy),
      `lib/timeline/{operations,placement}`, `lib/agent/{orchestrator,
      conceptResolver,reinforcement,runAgentCommand}`, `lib/ocr/*`
      (honest unavailable). Wired into `handleAgent` before
      `tryQuickShortcut`; falls through on miss / visual-needed. Concept
      search uses the local transcript; "add" appends; exact ranges kept;
      undo preserved; no fixed clip count/duration. Config: `AGENT_POLICY`
      + `AGENT_GUARDRAILS`. Tests: +50 (`npm test` = 86 pass) via a
      `node --test` `.ts` resolver hook (`scripts/ts-ext-hook.mjs`).
      typecheck + build ✓. Browser/transcript runtime test pending.
      See `memory/AGENTIC_INTENT_LAYER_2026-06-17.md`.

- [x] (2026-06-11) **Documented OpenRouter-only single-model pin.**
      `.env.example` now shows `CLOUD_PROVIDER_ORDER=openrouter` + all
      `OPENROUTER_*_MODEL=openai/gpt-5.5-pro` (no real key). Verified the
      dispatcher already enforces OpenRouter-only with NO Gemini/Groq fallback
      when pinned, and that all routes use `OPENROUTER_DEFAULT_MODEL`. Key
      stays server-side only; no code logic change. Transcription still local
      Whisper (unchanged). typecheck + build ✓. Live key test is user-side.

- [x] (2026-06-11) **Self-healing IndexedDB.** Fixed the "object store was not
      found" crash: gave each idb store its own DB (transcripts moved to
      `shorts-studio-transcripts`, removing the dbName collision with the
      predictions cache) and added `withIdbRecovery` (delete only the affected
      DB + retry once) in `lib/store/idb.ts`. Public `idbSessions/idbCache/
      idbLog` API unchanged. Persistent failure shows a clean "clear site
      data" message. Only affected DB cleared; no video/base64/key logging.
      typecheck + build ✓. **Browser corruption test still pending** (no
      browser in sandbox) — see manual case below.

- [x] (2026-06-11) **Dynamic duration — removed forced/default 30s.** Length is
      explicit-only now: no user-named duration → quality-floor selection,
      emergent length, "flexible length" in UI/copy; user-named duration →
      parsed `targetShortSeconds` + budgeted fit. Fixed planner prompt (D1
      "never assume 30s"; platform=format-only; parse examples), briefing
      follow-up chips (no 30s default), `PlanPreview`, starter chip, activity
      log, and `memoryFromPlan` (no phantom-30s memory leak). Pipeline branch
      was already correct. typecheck + build ✓.
- [x] (2026-06-11) **Added `CLOUD_PROVIDER_ORDER` env toggle.** Server-only
      comma-separated var (openrouter|gemini|groq) overrides the config
      provider order so you can switch between OpenRouter and Gemini (or pin
      one) without code changes. `lib/env.ts` + `configuredOrder()` in
      `lib/providers/cloud.ts`; `.env.example` documented. typecheck + build ✓.
- [x] (2026-06-11) **Fix: provider circuit-open no longer blocks fallback.**
      Made the route-level circuit pre-check opt-in (only single-provider
      Gemini-direct routes pass `provider`); moved circuit-skip + fallback
      into `lib/providers/cloud.ts` (`attemptableOrder` skips open circuits,
      tries the next provider, best-effort if all open). `agent`/`briefing`/
      `clip` dropped the `provider` arg so an open OpenRouter circuit reroutes
      to Gemini/Groq instead of 503. Session/global limits unchanged; Groq
      stays text-only. typecheck + build ✓.
- [x] (2026-06-11) **Removed browser WebLLM; server-side OpenRouter provider.**
      Deleted `lib/llm/*` + `@mlc-ai/web-llm` + `LOCAL_LLM`/`LOCAL_FIRST` +
      `NEXT_PUBLIC_LOCAL_FIRST_EDITOR` + the editor's local-first gate +
      `executeLocalFirstAction` + the apply-local-first workflow. Added
      `lib/providers/openrouter.ts` (server-only) + `lib/providers/cloud.ts`
      dispatcher (OpenRouter → Gemini → Groq); `/api/agent`,
      `/api/agent/briefing`, `/api/vision/clip` route through it. Key is
      server-only (no `NEXT_PUBLIC_OPENROUTER_API_KEY`, verified absent from
      client bundle); no browser model download; deterministic client actions
      kept; Gemini remains the vision fallback; no fake vision data.
      `npm install`/`typecheck`/`build` ✓.
- [x] (2026-06-11) **Local-first high-tier model → Hermes-3-Llama-3.1-8B.**
      `LOCAL_LLM` in `lib/config.ts` now uses Hermes-3-Llama-3.1-8B
      (`q4f16_1-MLC`) for the high tier (WebLLM function-calling/tool-use
      model), Qwen2.5-3B for mid, Llama-3.2-1B for low; added additive
      `roles` metadata. Gemini still required as cloud planner + vision
      fallback; flag default still OFF; no cloud-flow change; no fake vision
      data. Full Gemini-optional still needs real frame-tree/caption/vision-
      core grounding.
- [x] (2026-06-11) **Briefing endpoint resilience.** `/api/agent/briefing`
      retries once with fewer frames + a stricter compact prompt when the
      first Gemini response is unparseable, and degrades to a minimal 200
      fallback `BriefingResult` instead of a dead-end error. Safe logging
      (truncated model text, no base64/video). No UI/ffmpeg/scoring changes.
- [x] (2026-06-11) **Add GitHub Actions CI** (`.github/workflows/ci.yml`).
      Runs `npm run typecheck` + `npm run build` on PRs to `main` and pushes
      to `main` (Ubuntu, Node 20, npm cache, `npm ci`). Lint intentionally
      excluded (no ESLint config; `next lint` is interactive). Browser/WebGPU
      verification stays manual.
- [x] (2026-06-11) **Phase 4.5 polish — briefing `plan_topic` preserves
      `sourceId`.** Client-side plan now passes `sources:[action.sourceId]`
      into `normalizePlan`, so multi-source briefings stay grounded on the
      briefed source. No cloud call, no category logic.
- [x] (2026-06-11) **Phase 5 first extraction — `hooks/useBriefingActions.ts`.**
      Pulled the deterministic briefing follow-up handler out of
      `app/editor/page.tsx`, behavior-identical; page calls the hook.
- [x] (2026-06-11) **Structured briefing follow-ups (Phase 3).**
      `BriefingFollowUp` union + `lib/briefing/followups.ts` normalizer;
      `BriefingCard`/`AssistantPanel`/editor wired to dispatch intent
      (promote/plan_topic/extract_range) deterministically, chat via the
      normal pipe. Backward compatible with string follow-ups; no clarify
      loop.
- [x] (2026-06-11) **Phase 4.5 — safe deterministic local-first actions.**
      `localFirst.ts` now executes `promote`/`extract`/`reset` on-device
      behind `NEXT_PUBLIC_LOCAL_FIRST_EDITOR`; everything else + low
      confidence + missing data fall through to the unchanged cloud planner.
- [x] (2026-06-11) **Phase 4 v1 — local-first chat wiring** confirmed on
      main: `routeTurn` + grounded `chat` run on-device behind the flag.
- [x] (2026-06-11) Removed a duplicated quick-shortcut `catch` block in
      `app/editor/page.tsx` that broke TypeScript parsing; typecheck passes.
- [x] (2026-06-10) Clarify-branch briefing guard + narrowed synthesizeVaguePlan
      (Bug 1 + Bug 2).
- [x] (2026-06-10) Briefing follow-up clarify fix (PR #33, merged).
- [x] (2026-06-10) Merge frame-tree (#29), captioning (#30), temporal-pass
      fix (#28), local chat/tool/grounding system to `main`.
- [x] (2026-06-08) Create the persistent project-memory system
      (`memory/` + `AGENTS.md`).

> Add a date when you check something off, and consider a CHANGELOG entry for
> anything that changed behavior or structure.

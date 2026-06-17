# TODO

> Prioritized, actionable task list. Keep it short and current — move done
> items to **Completed** (and reflect notable ones in `CHANGELOG.md`).
> Larger directional items live in `ROADMAP.md`.
>
> Last updated: 2026-06-11 (documented OpenRouter-only pin → openai/gpt-5.5-pro, no fallback)

## High priority

- [ ] **PR 58 (remaining) — wire the transition foundation.** The model +
      honest mapping shipped (`lib/transitions/*`). Still TODO (larger):
      render worker consumes `BoundaryTransition[]` per boundary; transition
      picker UI between clips; chat commands ("add fade between clip 1 and
      2", "make transition cut", "add zoom transition"); actually render
      dip_to_black/slide/zoom (until then they map down honestly).
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

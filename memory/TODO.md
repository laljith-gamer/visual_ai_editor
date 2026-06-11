# TODO

> Prioritized, actionable task list. Keep it short and current — move done
> items to **Completed** (and reflect notable ones in `CHANGELOG.md`).
> Larger directional items live in `ROADMAP.md`.
>
> Last updated: 2026-06-11 (self-healing IndexedDB — fixed "object store not found" crash)

## High priority

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

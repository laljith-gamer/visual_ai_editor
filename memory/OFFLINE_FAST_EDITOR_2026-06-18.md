# 2026-06-18 — Offline fast-editor: command routing, memory persistence, storage budget, transcript errors

> Converts the app toward a fast, offline-first editor brain. Default
> path is deterministic + instant; cloud AI is already disabled by
> default in code (`cloudAiDisabled()` returns true when `DISABLE_CLOUD_AI`
> is unset — the PROJECT_STATE "cloud-primary" text was stale; trusting
> code per the protocol).

## Phase 1 — Fast command routing (the big fix)

The reported bug: "yes do it" / "undo" fell through to the planner and
became "look for yes/undo moments".

- New `lib/intent/fastCommands.ts` — pure, dependency-free, ANCHORED
  (`^…$`) classifier → `affirm | cancel | undo | redo | render`. Anchoring
  means partial commands ("go to clip 2", "render the part where he
  scores") are NOT caught and flow on to the parser. Long utterances
  (>6 words) are ignored. Instant (<1ms).
- `lib/agent/runAgentCommand.ts` now runs `handleFastCommand` at the TOP
  of `tryAgentCommand`, before memory/orchestrate, with this priority:
  1. pending confirmation — `affirm`/`cancel` WITH a pending action return
     `handled:false` so the EXISTING quick-shortcut gate runs/clears it
     (no duplicated logic).
  2. `undo` → `store.undoTimeline()`, `redo` → `store.redoTimeline()`
     (ALWAYS, never the planner).
  3. `render`/`export` → real render via `deps.onRender` (wired to the
     editor's `handleRender` through a new `handleRenderRef`).
  4. `affirm`/`cancel` with NOTHING pending → a deterministic nudge
     message (never a content search).
  Then direct timeline commands, transcript concept search, and
  visual fall-through (unchanged).
- Store: added one-step **redo** (`redoTimeline` + `redoHighlights` /
  `redoSelectedClipId`). `undoTimeline` stashes the pre-undo timeline;
  any fresh mutation clears redo (via `snapshot()`).
- Result: all the listed control/direct commands resolve in <1s with no
  WebGPU / model load.

## Phase 2 — Offline agent-memory persistence

- New idb store kind `agentMemory` (own DB `shorts-studio-agent-memory`)
  in `lib/store/idb.ts` (+ `idbAgentMemory` wrapper).
- New `lib/agent-memory/persistence.ts`: `loadAgentMemory` /
  `saveAgentMemory` / `clearAgentMemory` / `hydrateAgentMemory` (uses the
  store's existing `serialize`/`hydrate`).
- New pure `getRelevantMemory(store, {query,limit,minConfidence})` in
  `lib/agent-memory/context.ts` — returns records ordered by the project
  PRIORITY rule (user_stated > reinforcement > clip > source > flow >
  observed > preference), then confidence, then recency; query-filtered
  but always keeps user-stated rules.
- `runAgentCommand` hydrates once per session (`ensureHydrated`) and saves
  after any memory-mutating turn (fire-and-forget). Refresh now preserves
  flow + reinforcement + observed facts. Only the compact serialization is
  stored — NO video blobs / transcript text / frames.

## Phase 3 — Storage manager + cache budget

- `lib/config.ts` `STORAGE_BUDGET` — mobile (model 150 / frame 50 /
  render 100 MB) and desktop (600 / 300 / 500 MB) caps +
  `modelDownloadWarnBytes` (80 MB).
- `lib/storage/budget.ts` (pure, testable): `selectBudget`,
  `overBudgetCategories`, `shouldWarnBeforeModelDownload`, `formatBytes`,
  `StorageBreakdown`.
- `lib/storage/manager.ts` (browser, feature-detected, no-ops on server):
  `estimateStorageBreakdown()` (model = Cache Storage; frame = idb cache;
  transcript = idb transcripts; render = in-memory blob; project = idb
  sessions+logs+video-memory+agent-memory; total via
  `navigator.storage.estimate`), plus cleanup: `clearRenderedFiles`,
  `clearFrameCache`, `clearTranscriptCache`, `clearModelCaches`,
  `clearAllProjectData`. NOTE: a storage PANEL UI is not yet wired — the
  measurement + cleanup API is ready for it (TODO).

## Phase 4 — Transcription error honesty (targeted, safe)

The real silent-failure bug: `useTranscription`'s job `catch` logged but
left `progress` unchanged, so the drawer fell back to "No transcript yet".
- `hooks/useTranscription.ts` now sets
  `progress = { phase:"error", error:<message> }` on failure.
- `components/TranscriptDrawer.tsx` renders an explicit "Transcription
  failed: <reason>" card (with Try again) when `phase==="error"`, instead
  of the silent empty state.
The deeper pipeline reliability/speed work (audio chunking tuning, model
tiering) is browser-runtime-only and NOT done here — see TODO.

## Phase 5 — Transcript clipping

Already implemented offline by `lib/agent/conceptResolver.ts` (built
2026-06-17): exact range → local transcript token match → OCR (honest
unavailable) → visual fall-through. No WebGPU needed for the transcript
path. Routing reaches it via the orchestrator's `add_concept`. No change
needed; verified.

## Phase 10 — Tests (+16; 102 total, all pass)

- `lib/intent/fastCommands.test.ts`, `lib/agent-memory/memory.test.ts`
  (serialize/hydrate, observed evidence, direct>observed priority, query
  filter), `lib/storage/budget.test.ts` (caps, over-budget, warn,
  formatBytes). Added to `npm test` / `npm run test:agent` via the
  existing `.ts` resolver hook.

## NOT done (honest)

- Phase 6 (cheap CPU best-parts: motion/scene/audio-energy/silence/blur
  scoring) — not implemented; "best parts" still routes to the existing
  visual pipeline (which needs WebGPU) via `needs_visual`.
- Phase 7 (explicit visual-AI gating UI / size-estimate prompt) — the
  app already degrades when WebGPU is absent; a dedicated enable-prompt
  is not added.
- Phase 9 (PWA / service worker / app-shell offline) — not added.
- Storage PANEL UI (Phase 3 UI surface) — API ready, panel not wired.
- Device-mode selector (Tiny/Standard/Vision/Power) — conceptual; not a
  single explicit setting yet.
- Browser/WebGPU + transcription RUNTIME verification — cannot run in the
  sandbox (no GPU, no media decode). Required manually.

## Validation
`npm run typecheck` ✓ · `npm run build` ✓ (`/editor` 168 kB first load) ·
`npm test` = 102 pass / 0 fail.

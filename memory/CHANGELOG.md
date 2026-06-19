# CHANGELOG (project memory)

> A dated log of **notable changes** to the project and its memory. This is a
> lightweight, human-readable history — not a replacement for git history or
> the app's own product changelog (`/CHANGELOG.md` at the repo root).
>
> Newest entries at the **top**. Keep each entry concise.

## Entry format

```
### YYYY-MM-DD — Short title
- **Change made:** what happened.
- **Files affected:** key paths.
- **Reason:** why.
```

---

### 2026-06-19 — Meta question guard (explanation questions never mutate the timeline)
- **Change made:** Added a deterministic, READ-ONLY meta/explanation guard
  that runs BEFORE every mutation path so questions like "explain why you did
  these changes" / "what changed" / "why this clip" / "why only fade" are
  ANSWERED in chat and never routed into edit-command parsing or the planner
  (which previously could mutate the timeline).
  - **`lib/intent/metaQuestions.ts` (new, pure, no imports):**
    `parseMetaQuestion(text)` → `MetaQuestion { kind, confidence, target }` or
    null. Kinds: explain_previous_changes / what_changed / why_clip_selected /
    why_plan / what_will_happen / capability_explanation. Requires a meta cue
    (why/explain/what/how come) AND negative-guards any sentence that STARTS
    with an edit verb (add/remove/delete/trim/replace/move/render/export/make/
    create/build/change/fix/…) so "add explanation text", "make an explanation
    video", "add why text", "change this clip" are NOT meta.
  - **`lib/agent/metaAnswer.ts` (new, pure, type-only imports):**
    `answerMetaQuestion(question, state)` explains from CURRENT state only
    (plan, highlights, selected clip, boundary transitions, memory, sources,
    last messages). Honest: no edit, no analysis, no fake claims; "No edit has
    been applied yet." when empty; transition answers state the renderer only
    does cut/fade/crossfade (crossfade = fade dip) and richer transitions are
    mapped down, never faked.
  - **Integration (`app/editor/page.tsx`):** the guard is the FIRST thing in
    `handleAgent` after the user message — before `tryAgentCommand`, the
    transition parser, the intake layer, the quick-shortcut gate, and the
    cloud/local planner. On a match it pushes the answer, logs `meta.explained`,
    clears the busy spinner, and returns WITHOUT touching highlights/plan/status.
  - **Double safety (`lib/agent/runAgentCommand.ts`):** `tryAgentCommand` also
    runs the guard first and returns `handled:true` with a read-only answer, so
    no caller (e.g. the dev intent tester) can mutate on a meta question.
- **Files affected:** `lib/intent/metaQuestions.ts` (+ `.test.ts`),
  `lib/agent/metaAnswer.ts` (+ `.test.ts`), `app/editor/page.tsx`,
  `lib/agent/runAgentCommand.ts`, `package.json` (test + test:meta scripts).
- **Reason:** There was no first-class meta/explanation intent, so explanation
  questions fell through into edit-command parsing or the planner and could
  edit clips / change the timeline. Users asking "why did you…" expect an
  explanation, never an edit.
- **Validation:** `npm run typecheck` ✓, `npm run build` ✓ (/editor 180 kB),
  `npm test` = **306 pass / 0 fail** (+38 new: meta detection for explain/why/
  what-changed/why-clip/why-plan/capability/render, negative guards for edit
  verbs, and read-only answers incl. the empty-timeline "No edit applied yet"
  and the fade/transition limitation). Existing edit commands still parse to
  null in the guard and flow through unchanged.

---

### 2026-06-19 — Project history restore: full-snapshot autosave (runtime fix)
- **Change made:** Fixed the runtime failure where restored projects were
  stale/wrong after reload. Root cause was NOT the hash matching — it was that
  autosave only watched `highlights.length`, `plan?.scenarios.length`, and
  `messages.length`, so most durable project changes were never written.
  - **`lib/store/projectSignature.ts` (new, pure, tested):**
    `projectPersistSignature(state)` builds a stable string over ALL durable
    project state — sessionId, title, source ids+hashes+names+addedAt, missing
    placeholder ids+hashes, activeSourceId, selectedSourceIds, a full plan
    identity, highlight id/sourceId/start/end/label, selectedClipId, boundary
    transitions, pendingTimelineOp, pendingExecution, mode, inferred chips,
    userTier, lastBriefing id/sourceId/part-count, messages length+last id+ts,
    memory, and status. `progress` is INTENTIONALLY excluded so per-frame
    pipeline ticks never trigger a write.
  - **`app/editor/page.tsx`:** autosave now watches the signature
    (`useEditorStore((s) => projectPersistSignature(s))`) and persists on a
    500ms debounce. Removed the narrow `[highlights.length, plan?.scenarios
    .length, messages.length]` effect (and the now-unused `messages` selector).
    This catches source upload/hydration, missing-source changes, active/
    selected source, selected clip, boundary transitions, pending op/exec,
    mode, tier, inferred, last briefing, memory, and restore — without spamming
    IndexedDB on progress and without persisting blobs.
  - **`lib/store/projectRestore.ts` — `SessionSummary` / `summarizeSession`:**
    replaced the misleading single `missingCount` with `sourceCount`,
    `saveTimeMissingCount` (placeholders at save time) and `restoreNeededCount`
    (= `sourceCount` whenever there are sources, because blobs aren't persisted
    — every source needs re-upload on a fresh load).
  - **`components/ProjectRail.tsx`:** history now shows "needs re-upload" (or
    "N need re-upload") instead of wrongly showing "0 missing".
- **Files affected:** `lib/store/projectSignature.ts` (+ `.test.ts`),
  `app/editor/page.tsx`, `lib/store/projectRestore.ts` (+ `.test.ts`),
  `components/ProjectRail.tsx`, `package.json` (test scripts).
- **Reason:** Restore "worked in memory" but the updated project state wasn't
  being saved because autosave watched only chat/plan/highlight COUNT, so a
  reload/history-refresh showed stale data. The existing pure restore helpers
  were correct and were kept; only the persistence TRIGGER and the history
  missing-count were wrong.
- **Validation:** `npm run typecheck` ✓, `npm run build` ✓ (/editor 177 kB),
  `npm test` = **268 pass / 0 fail** (+25 new: signature changes for every
  durable field, progress-only no-op, and `restoreNeededCount` summary cases).
  Browser reload/restore runtime verification still recommended.

---

### 2026-06-19 — Project history restore (Phase 1 + 2 + 3)
- **Change made:** Sessions now restore the WHOLE editing project, not just
  chat. Sources come back as hash-keyed placeholders (no blobs persisted);
  re-uploading the same file reconnects it to the original source id and the
  saved timeline becomes usable again — without rebuilding anything.
  - **`lib/store/projectRestore.ts` (new, pure, tested):** the restore brain.
    `migrateSessionToManifests` (v1 `videoMeta`/`videoHash` → 1 manifest;
    v1.6 `sources[]` → manifests; v2 `sourceManifests` as-is — full backward
    compat), `backfillHighlightSources` (legacy untagged clips → the single
    source id), `buildRestoredProjectState` (manifests → MISSING placeholders
    + active/selected ids; never allocates a URL), `resolveUploadIdentity`
    (HASH-only match → hydrate existing id vs new source — filename is a hint,
    never identity), `usedMissingSources` / `canRenderTimeline` (render guard),
    `summarizeSession` (history summary), `buildPersistManifests` (hydrated
    "available" + missing — nothing lost on a partial-restore re-save).
  - **Types (`lib/types.ts`):** `PersistedSourceManifest`,
    `RestoredSourcePlaceholder`, `ProjectSource` union; `Session` extended
    (optional, backward compatible) with `sourceManifests`, `selectedClipId`,
    `boundaryTransitions`, `pendingTimelineOp`, `pendingExecution`, `inferred`,
    `userTier`, `lastBriefing`, `schemaVersion: 2`.
  - **Store (`hooks/useEditorStore.ts`):** new `missingSources` state +
    `hydrateRestoredSource` (hash-match → reconnect original id, attach blob/
    url, restore active/selected; else falls back to `addSource`),
    `usedMissingSources()`, `canRenderCurrentTimeline()`. `restoreSession`
    rebuilt on the pure helper (placeholders, not a wiped library; preserves
    highlights/plan/transitions/selected clip/mode/tier/briefing). `persist`
    writes the full manifest + state at `schemaVersion: 2`. `removeSource`
    also drops a missing placeholder on EXPLICIT delete (restore never calls
    it); `setActiveSource` accepts a missing id (preview blank until re-upload).
  - **UI — ProjectRail:** "This project needs N missing video(s)" banner,
    missing-source placeholder cards (filename / duration / aspect / "Missing —
    re-upload to restore" + Re-upload button), a "Restored previous video: …"
    confirmation on a hash match, and a richer history list (videos / clips /
    duration / format / status / missing count / last action).
  - **UI — Timeline:** missing-source clips render with a dashed "⚠ source
    missing" marker and are not draggable/resizable; missing sources appear in
    the source tabs so the previous arrangement stays legible pre-re-upload.
  - **Render guard (`app/editor/page.tsx`):** `handleRender` blocks with an
    honest "Re-upload the missing source video before rendering: …" when any
    clip references an unhydrated source — ffmpeg/mediabunny never sees a
    missing input.
  - **Upload paths (`ProjectRail`, `app/launch/page.tsx`):** both now call
    `hydrateRestoredSource`, so a re-upload reconnects by hash from either entry
    point; a non-matching file is added as a new source (never a silent swap).
- **Files affected:** `lib/store/projectRestore.ts` (+ `.test.ts`),
  `lib/types.ts`, `hooks/useEditorStore.ts`, `components/ProjectRail.tsx`
  (+`.module.css`), `components/Timeline.tsx` (+`.module.css`),
  `app/editor/page.tsx`, `app/launch/page.tsx`, `package.json`.
- **Reason:** History only restored chat; restored timelines were disconnected
  from their uploads, and a re-upload made a NEW id (orphaning old clips). Users
  expect "I uploaded this before — if I upload it again, arrange the old
  timeline automatically." Local-first, no blobs persisted by default, hash is
  the identity source of truth.
- **Validation:** `npm run typecheck` ✓, `npm run build` ✓ (/editor 176 kB),
  `npm test` = **243 pass / 0 fail** (+18 new restore tests covering migration
  v1/v1.6/v2, highlight preservation, hash hydrate vs new, render guard,
  active/selected restore, no-URL placeholder, persist round-trip, summary).
  Browser runtime verification (real re-upload + render) still required.
- **Scope honesty:** Phase 4 (opt-in blob persistence + File System Access
  handles + rendered-output history) is NOT done by design. Test #10 (explicit
  removeSource drops source + highlights) is covered by existing store
  behaviour (extended for placeholders), verified via typecheck + manual.

---

### 2026-06-19 — Agentic intake layer (universal vague-request handling, Phase 1)
- **Change made:** Added a NEW universal layer BEFORE the existing planner so
  the app behaves like an agentic editor for vague/messy requests ("make this
  cool", "make a reel", "edit for YouTube") instead of feeding bad prompts to
  the planner. It does not replace the planner — it improves the input.
  - **`lib/agentic-intake/editBrief.ts` (new, pure):** the universal
    `EditBrief` type (intentKind / sourceScope / output / content / style /
    effects / constraints / confidence / missing) + `createEmptyBrief` +
    `mergeBrief` (multi-turn merge — a known value never loses to "unknown").
  - **`lib/agentic-intake/capabilityMatrix.ts` (new, pure):** honest
    `CAPABILITY_MATRIX` (supported: vertical/horizontal/square output, trim/
    extract, highlight reel, continuous, merge/compose, fade, keep-original
    audio; partial: crossfade=fade-dip, crop_reframe; UNSUPPORTED: slow_zoom,
    speed_change/ramp, color_grade, camera_shake, letterbox, text_overlay,
    captions, blur, lower/mute audio, music/SFX/voiceover) + `classifyEffects`.
  - **`lib/agentic-intake/inferBrief.ts` (new, pure):** `inferBrief` /
    `finalizeBrief` / `computeMissing`. Reuses `videoPromptInterpreter`
    (duration/format/platform/scope/topic/exclusions). Infers obvious defaults
    (one video → current scope; platform → format). NO genre table — subject
    words are treated uniformly; style/scope words are stripped so "dark
    trailer" never becomes a fake content focus.
  - **`lib/agentic-intake/questionEngine.ts` (new, pure):** `decideQuestion`
    asks ONE focused option-chip question at a time in priority order
    (source_scope → output_type → content_focus → duration → format → style →
    text → audio → avoid), returning the existing `ClarifyQuestion` shape.
  - **`lib/agentic-intake/promptCompiler.ts` (new, pure):** `compileBriefPrompt`
    (clean, structured, capability-honest planner prompt — never echoes raw
    text; unsupported effects listed as future requests, never claimed) +
    `briefSummaryMessage` ("Got it — I'll make a 35s vertical dark trailer…").
  - **`lib/agentic-intake/routeDecision.ts` (new, pure):** `decideRoute` →
    fast_command / vision_briefing / clarify / deterministic / cloud_planner /
    local_planner / manual_fallback (capability-aware; describe with no cloud
    vision → honest manual_fallback, never a text-only planner).
  - **`lib/agentic-intake/intake.ts` (new, pure):** `planIntake` orchestrator
    → clarify / proceed (compiled prompt + summary) / passthrough.
  - **`lib/agentic-intake/runIntake.ts` (new, client):** store adapter with a
    per-session partial brief (multi-turn) — the only store-aware piece.
  - **Integration (`app/editor/page.tsx`):** intake runs AFTER `tryAgentCommand`
    and BEFORE the quick-shortcut/cloud paths. Conservative + additive — it only
    shepherds fresh creation requests (clarify → reuses `pendingClarify` +
    `QuickReplies`; proceed → clears stale clarify + hands the compiled prompt
    to the local-planner fallback); refinements (a plan exists), describe/vision,
    and fast commands pass straight through unchanged.
  - **`lib/local-llm/localPlanner.ts`:** `tryLocalPlannerFallback` accepts an
    optional `ctx.compiledPrompt` and plans from it instead of raw messy text
    (vision-honesty guard still runs on the original request).
- **Files affected:** `lib/agentic-intake/{editBrief,capabilityMatrix,inferBrief,
  questionEngine,promptCompiler,routeDecision,intake,runIntake}.ts` (+
  `inferBrief.test.ts`, `intake.test.ts`), `lib/local-llm/localPlanner.ts`,
  `app/editor/page.tsx`, `package.json` (test + test:intake scripts).
- **Reason:** Real users give vague/messy requests; the app must ask only the
  missing high-impact questions, infer obvious defaults, build a stable brief,
  and send a clean compiled prompt to the planner — universally (any video,
  any goal), with no genre hardcoding and no fake capability claims.
- **Validation:** `npm run typecheck` ✓, `npm run build` ✓ (/editor 174 kB;
  intake is a lazy chunk), `npm test` = **225 pass / 0 fail** (+27 new). Browser/
  WebGPU + live planner runtime verification still required (sandbox has neither).
- **Scope honesty:** Phase 1 only. Phase 3 (real visual-effect renderer, burned
  text overlays, audio SFX, capability-aware render warnings) is NOT done — the
  capability matrix marks those unsupported and the prompt compiler preserves
  them as requests, never as rendered.

---

### 2026-06-19 — Issue #64: professional video-prompt interpreter + all-source compose
- **Change made:** Messy editing prompts no longer fabricate topics. A new pure
  interpreter extracts structured slots before the specialized detectors run.
  - **`lib/intent/videoPromptInterpreter.ts` (new, tested):**
    `normalizeVideoPromptText` (spelling/spacing only), `parseDuration`,
    `parseClipCount` (guards "5 min"/"clip 5"), `parseFormat`, `parsePlatform`,
    `parseSourceScope`, `META_VOCAB` + `isMeaningfulContentTopic` +
    `extractMeaningfulTopic` (no-fake-topic guard, NOT a genre table),
    `splitExclusions`. Bounds in `VIDEO_PROMPT` config.
  - **`composeIntent.ts`:** topics only from `extractMeaningfulTopic`; per-source
    compose preserved; NEW all-source compose (`sourceScope:"all"` + duration /
    format / minClipCount / genericBestParts / allSourcesTopic, no per-source
    fakery).
  - **Type/exec:** `MultiSourceComposePlan` extended; `composeNormalize` reads
    the fields + allows empty sources for all-scope; `app/editor/page.tsx` fans
    all-source compose across every upload with honest underfill reporting and
    render-format wiring (`buildComposeOutputPlan`).
- **Files affected:** `lib/intent/videoPromptInterpreter.ts` (+test),
  `lib/plan/composeIntent.ts`, `lib/plan/compose.test.ts`,
  `lib/plan/composeNormalize.ts`, `lib/plan/composeSubPlan.ts`,
  `lib/plan/prompt.ts`, `lib/types.ts`, `app/editor/page.tsx`, `lib/config.ts`,
  `package.json`.
- **Reason:** Production bug #64 — "atleast sect 5 clip from all … combined 5 min
  vertical" was parsed into fake per-source topics ("atleast sect all" / "min
  vertical"). Validation: typecheck ✓, build ✓, 198 tests ✓.

### 2026-06-19 — Issue #62: generic best-parts intent + offline target-coverage fix
- **Change made:** A 40s "best picks for reels" request no longer collapses to
  a single 1.0s "ready to render" clip.
  - **Intent** (`lib/plan/deriveIntent.ts`): generic editing/output words
    ("best", "picks", "highlights", "make a reel") stop becoming SigLIP search
    subjects. New `ActionableIntent.genericBestParts` → focus "best moments",
    scenarioLabels `["visually rich moments"]`, duration preserved. NOT a
    genre table.
  - **Offline scoring** (`app/api/agent/route.ts`): generic best-parts uses
    `SIGNAL_DEFAULTS.visualInterest` (semantic = 0 → SigLIP skipped).
  - **CPU/offline fallback** (`lib/pipeline/bestParts.ts`, pure): expand short
    peaks + spread non-overlapping clips toward the target; no fixed clip
    count. Wired as an underfill guard in `lib/pipeline/highlights.ts`.
  - **Honest coverage** (`lib/pipeline/coverage.ts`, pure;
    `app/editor/page.tsx`): underfilled explicit-duration runs show an honest
    message, set the new `needs_review` status, and never push "Tap Render".
  - **Config** (`lib/config.ts`): `TARGET_COVERAGE` + `OFFLINE_BEST_PARTS`.
- **Files affected:** `lib/plan/deriveIntent.ts` (+test), `app/api/agent/
  route.ts`, `lib/config.ts`, `lib/pipeline/bestParts.ts` (+test),
  `lib/pipeline/coverage.ts` (+test), `lib/pipeline/highlights.ts`,
  `app/editor/page.tsx`, `lib/types.ts`, `components/Topbar.tsx`,
  `components/ProjectRail.tsx`, `package.json`.
- **Reason:** Production bug #62 — the app silently shipped a 1s short for a
  40s ask. It must now fill the target from local evidence or honestly say it
  can't and ask. Validation: typecheck ✓, build ✓, 172 tests ✓.

### 2026-06-19 — Auto transition picking (issue #57, PR 59 layer)
- **Change made:** The editor auto-picks the transition between clips from
  generic media signals (offline, deterministic, NO genre tables).
  - Engine: `lib/transitions/features.ts` (generic signals, graceful
    degradation), `auto.ts` (`selectAutoTransition`, documented precedence),
    `timeline.ts` (`buildAutoBoundaryTransitions`, preserves manual + clamps).
  - Config: `TRANSITIONS.autoPick` thresholds (documented guardrails).
  - Types: `BoundaryTransition` extended (optional mode/confidence/reason/
    evidence/render/exact/note) — backward compatible.
  - Store: `boundaryTransitions` + set/update/reset/recompute actions;
    editor recomputes on clip-sequence change; manual overrides survive.
  - UI: `components/TransitionsBar.tsx` (per-boundary chips, honest
    mapped-down labels).
  - Chat: `lib/intent/transitionCommands.ts` parsed before the planner;
    `runAgentCommand.handleTransitionCommand` applies + summarizes.
  - Render: pure `lib/pipeline/renderFilters.ts` (worker delegates);
    optional per-boundary `boundaryRenders` through `useFFmpeg` + ffmpeg
    worker + mediabunny; global fallback byte-identical.
- **Files affected:** `lib/transitions/{types,features,auto,timeline}.ts`
  (+ tests), `lib/config.ts`, `hooks/useEditorStore.ts`,
  `app/editor/page.tsx`, `components/{TransitionsBar,Timeline}.tsx`,
  `lib/intent/transitionCommands.ts` (+test), `lib/agent/runAgentCommand.ts`,
  `lib/pipeline/{renderFilters.ts (+test),render.worker.ts,mediabunny-render.ts}`,
  `hooks/useFFmpeg.ts`, `package.json`, `memory/*`.
- **Reason:** Transitions shouldn't be manual-only; the editor should
  understand adjacent clips + context and choose naturally — without fake
  effect claims and without WebGPU/cloud.
- **Honesty:** dip_to_black/slide/zoom/glitch/whip/match_cut map down with a
  note; crossfade currently renders as a fade dip (true xfade is future).
- **Validation:** typecheck ✓, build ✓, `npm test` = 155 pass / 0 fail
  (+36). On branch `feat/auto-transitions` — not yet merged.

---

### 2026-06-19 — PR 58: per-boundary transition foundation (small)
- **Change made:** Added the per-boundary transition MODEL + honest
  mapping (no render/UI change). `lib/config.ts` `TRANSITIONS` guardrails;
  `lib/transitions/types.ts` (`TransitionType`, `RenderableTransition`,
  `BoundaryTransition`, duration default/clamp); `lib/transitions/map.ts`
  (`mapTransition` exact-vs-down-mapped + honest `note`, `toRenderable`,
  `describeMappedDowns`). glitch/whip/match_cut + dip_to_black/slide/zoom
  map down and are flagged not-exact (never claimed rendered).
- **Files affected:** `lib/config.ts`, `lib/transitions/types.ts`,
  `lib/transitions/map.ts` (+ `map.test.ts`), `package.json`, `memory/*`.
- **Reason:** Issue #57 PR 58 foundation — production needs per-boundary
  transitions; capture the model + honest mapping first, keep it small and
  low-risk. Render worker + picker UI + chat wiring are the follow-up.
- **Validation:** typecheck ✓, build ✓, `npm test` = 119 pass / 0 fail.

---
- **Change made:** Reliable export/download + a render-vs-export split in
  the fast command router.
  - New `lib/util/download.ts`: pure `safeTitleSegment` / `exportTimestamp`
    / `buildExportFilename` (→ `shorts-studio-{title}-{yyyyMMdd-HHmmss}.mp4`)
    + browser `shareOrDownload` (Web Share → anchor download; reports
    shared/downloaded/blocked/cancelled for honest fallback guidance).
  - `hooks/useShare.ts` refactored onto `shareOrDownload`; new
    `hooks/useExport.ts` (no-blob → "Render first"; blocked → guidance;
    success → "Saved <filename>").
  - `components/PreviewToolbar.tsx`: Export button always visible + status
    message; never silently does nothing.
  - `lib/intent/fastCommands.ts`: new `export` kind (export/download/save)
    distinct from `render`; pure exhaustive `decideFastAction(kind,state)`.
  - `lib/agent/runAgentCommand.ts`: `handleFastCommand` is async + uses
    `decideFastAction`; chat "export" → `deps.onExport`, "render" →
    `deps.onRender`. `app/editor/page.tsx` wires `onExport` via
    `handleExportRef`.
- **Files affected:** `lib/util/download.ts` (+test), `hooks/useShare.ts`,
  `hooks/useExport.ts`, `components/PreviewToolbar.tsx`,
  `lib/intent/fastCommands.ts` (+test update), `lib/agent/runAgentCommand.ts`,
  `app/editor/page.tsx`, `package.json`, `memory/*`.
- **Reason:** Issue #57 PR 57 — make basic editing reliable without
  AI/WebGPU/backend. Export was the real gap (hardcoded filename, hidden
  when no blob, no fallback). Render/export must never reach the planner
  and must share one core path with their buttons.
- **Validation:** `npm run typecheck` ✓, `npm run build` ✓ (169 kB),
  `npm test` = 112 pass / 0 fail. Browser manual verification still
  required (upload/preview/real download).

---

### 2026-06-18 — Offline fast-editor: command routing, memory persistence, storage budget, transcript errors
- **Change made:**
  - **Phase 1 (fast routing):** new pure `lib/intent/fastCommands.ts`
    (anchored classifier affirm/cancel/undo/redo/render). `runAgentCommand`
    runs it FIRST: confirmations/undo/redo/render never reach the planner;
    "yes do it"/"undo" can no longer become "look for X moments". Priority:
    pending-confirm (delegates to existing quick-shortcut gate) → undo/redo
    (store) → render (real `handleRender` via new `handleRenderRef`) →
    affirm/cancel-with-nothing-pending (nudge) → direct commands. Added
    one-step **redo** to the store (`redoTimeline` + redo snapshot slots,
    cleared by any fresh mutation).
  - **Phase 2 (persistence):** new `agentMemory` idb store +
    `lib/agent-memory/persistence.ts` (load/save/clear/hydrate) + pure
    `getRelevantMemory` (priority user_stated > reinforcement > clip >
    source > flow > observed > preference). Hydrate once/session; save
    after memory-mutating turns. No blobs stored.
  - **Phase 3 (storage):** `STORAGE_BUDGET` caps in config +
    `lib/storage/budget.ts` (pure) + `lib/storage/manager.ts` (measure via
    Cache Storage/idb/`navigator.storage.estimate`; cleanup actions).
  - **Phase 4 (transcript honesty):** `useTranscription` sets explicit
    `phase:"error"` on failure; `TranscriptDrawer` renders "Transcription
    failed: <reason>" instead of a silent "No transcript yet".
  - **Phase 10 (tests):** +16 (fastCommands, memory, storage/budget) →
    102 pass.
- **Files affected:** `lib/intent/fastCommands.ts` (+test),
  `lib/agent/runAgentCommand.ts`, `hooks/useEditorStore.ts` (redo),
  `app/editor/page.tsx` (render ref + onRender), `lib/store/idb.ts`
  (agentMemory kind), `lib/agent-memory/{persistence.ts,context.ts}`
  (+ `memory.test.ts`), `lib/storage/{budget.ts,manager.ts}`
  (+ `budget.test.ts`), `lib/config.ts` (`STORAGE_BUDGET`),
  `hooks/useTranscription.ts`, `components/TranscriptDrawer.tsx`,
  `package.json`, `memory/*`.
- **Reason:** Make the default path a fast offline editor brain: control
  commands instant and never mis-routed to the planner; memory survives
  refresh; local cache is measurable/capped; transcription fails loudly
  with a real reason. Cloud AI is already off by default in code.

---
- **Change made:** Added a net-new deterministic AGENT layer so the editor
  acts like an assistant, not a command bot. It resolves natural editing
  commands into structured timeline operations BEFORE the cloud planner,
  and is additive + reversible (falls through to the unchanged
  quick-shortcut gate + cloud planner on a miss / when visual analysis is
  needed).
  - **Phase 1 — `lib/intent/`:** `command.ts` (`EditCommand` union +
    refs/specs + `AgentCommandContext`), `timeRangeParser.ts`,
    `sourceResolver.ts`, `clipResolver.ts`, `placementResolver.ts`,
    `editCommandParser.ts`. Reuses `time.ts` / `dictionary.ts`. Kept
    separate from the existing `types.ts` `QuickMatch` envelope.
  - **Phase 2 — `lib/agent-memory/`:** `types/store/observer/resolver/
    policy/context`. User-stated vs observed records, each with confidence
    + evidence; flow + reinforcement memory; confidence policy (execute
    ≥0.85 / note ≥0.65 / clarify).
  - **Phase 3 — `lib/timeline/`:** `operations.ts` + `placement.ts` (pure
    `Highlight[]` transforms; exact ranges kept; order preserved via
    `setHighlights`).
  - **Phase 4 — `lib/agent/orchestrator.ts`:** observe → reinforcement →
    parse → resolve → policy → `AgentDecision`.
  - **Phase 5 — `lib/agent/conceptResolver.ts`:** exact range → LOCAL
    transcript → OCR (honest unavailable) → visual fallback. Generic
    "best parts" → visual, NO fixed count.
  - **Phase 6 — `lib/ocr/`:** `OcrEngine` interface + honest
    `available:false` query; no heavy dep added.
  - **Phase 7 — reinforcement:** detection + pure `adjustScore`.
  - **Phase 8 — UI feedback:** one assistant message per action with
    assumptions + an `agent` attachment carrying the evidence label
    ("transcript match" / "exact range") + confidence.
  - **Wiring — `lib/agent/runAgentCommand.ts`:** `tryAgentCommand` builds
    context + per-session memory from the store, applies resolved ops via
    the store (undo preserved), lazy-imported into `app/editor/page.tsx`
    `handleAgent` before `tryQuickShortcut`.
  - **Config:** `AGENT_POLICY` + `AGENT_GUARDRAILS` in `lib/config.ts`
    (documented SAFETY guardrails — no hidden clip-count/duration).
  - **Tests:** `scripts/ts-ext-hook.mjs` + `register-ts-ext.mjs` (a
    `node --test` resolver hook appending `.ts` to extensionless relative
    imports) + 6 new test files. `npm test` = 86 pass / 0 fail.
- **Files affected:** `lib/intent/{command,timeRangeParser,sourceResolver,
  clipResolver,placementResolver,editCommandParser}.ts` (+ `.test.ts`),
  `lib/agent-memory/{types,store,observer,resolver,policy,context}.ts`
  (+ `policy.test.ts`), `lib/timeline/{operations,placement}.ts`
  (+ `operations.test.ts`), `lib/agent/{orchestrator,conceptResolver,
  reinforcement,runAgentCommand}.ts`, `lib/ocr/{types,query}.ts`,
  `lib/config.ts`, `app/editor/page.tsx`, `package.json`,
  `scripts/ts-ext-hook.mjs`, `scripts/register-ts-ext.mjs`; `memory/*`.
- **Reason:** Make the editor resolve source/clip/range/concept/placement
  references, observed memory, and reinforcement deterministically — only
  asking to clarify when truly ambiguous — without any hidden hardcoded
  clip count or forced duration, and without breaking the existing render
  pipeline / cloud planner.
- **Privacy/honesty:** fully client-side; no video upload; no provider
  keys touched; OCR/vision not faked (OCR reports unavailable; visual
  concept search defers to the existing pipeline).
- **Validation:** `npm run typecheck` ✓, `npm run build` ✓ (`/editor`
  first-load JS 168 kB; agent layer is a lazy chunk), `npm test` 86 pass.
  **Browser/WebGPU + transcript runtime verification still required** —
  the sandbox has neither.

---
- **Bug:** "pick combat in the first video and the cutscene in the second and
  make it transition" never reached compose. The cloud planner mis-routed it
  to a single-source plan and the generic `deriveActionableIntent` fallback
  built junk scenarios ("pick / first / cutscene / transition moments"), then
  the single-source run died with a vague "Decoding error".
- **Fix:** added a deterministic, high-precision multi-source detector and
  gave it PRIORITY over the generic fallback.
  - **`lib/plan/composeIntent.ts` (new, import-free):** `deriveComposeIntent`
    parses clauses → source refs ("first video"→0, "video 2"→1, "in the
    second"→1, guarded against "first 30 seconds") + content topics
    (stopword-stripped, so "combat"→"combat moments", "cutscene"→"cutscene
    moments"). Tiers: A = ≥2 per-source picks (high conf, overrides cloud),
    B = mix/combine + ≥2 topics (e.g. "mix combat and cutscene" → interleave),
    C = ordering-only montage ("first … then shuffle the rest" → shuffle +
    anchorFirst). Detects ordering + transition; builds a ready
    `MultiSourceComposePlan` + clean message. Returns null on single-source/
    merge/edit prompts (precision over recall).
  - **`app/api/agent/route.ts`:** new priority order — (1) high-confidence
    compose override right after parse, (2) cloud-planner compose, (3) normal
    plan/edit/describe, (4) generic `deriveActionableIntent`, (5) clarify.
    Compose is also checked BEFORE the generic fallback in the planner-failure
    catch (504/timeout), the clarify branch, and the plan-fail branch, via the
    shared `buildComposeResponse` helper.
  - **`lib/plan/deriveIntent.ts`:** belt-and-braces — added pick/first/second/
    third/fourth/upload/transition/merge/combine/mix/shuffle/montage/another to
    STOPWORDS so the generic path can never emit those as labels.
  - **`app/editor/page.tsx`:** compose branch now requires ≥2 library sources
    (context-aware ask for a second video otherwise, never a generic topic
    question); per-source `executeForSource` is wrapped so a decode/analysis
    failure names the offending video + does NOT touch the timeline ("Couldn't
    decode the second video … Your previous timeline was not changed.").
  - **`lib/plan/prompt.ts`:** compose section already explicit; this change
    makes selection deterministic regardless of planner behaviour.
- **Tests:** `lib/plan/compose.test.ts` +9 (canonical prompt, anchorFirst
  shuffle, mix→interleave, video-N picks, explicit fade, precision nulls,
  findSourceIndex); `deriveIntent.test.ts` +1 (no junk labels). `npm run
  test:compose` = 29 pass, `npm run test:intent` = 8 pass.
- **Files affected:** `lib/plan/composeIntent.ts` (new), `app/api/agent/route.ts`,
  `lib/plan/deriveIntent.ts`, `app/editor/page.tsx`, `lib/plan/compose.test.ts`,
  `lib/plan/deriveIntent.test.ts`.
- **Reason:** clear multi-source montage requests must deterministically reach
  compose, never a single-source junk plan or a vague decode error. Verified
  `npm run typecheck` + `npm run build` pass. Browser/WebGPU per-source vision
  run still needs manual verification.


- **Change made:** Completed the agentic-clarify fix after runtime showed
  "Planner returned 504" + a stale topic question + raw broken text echoed.
  - **(A) Planner-failure fallback** (`app/api/agent/route.ts`): the
    `cloudPlannerJson` catch now runs `deriveActionableIntent` BEFORE
    returning an error. On 504/503/timeout/transient, if the prompt is
    actionable it synthesizes a plan (mode "plan") and proceeds; with no video
    it returns the upload-first message; only a truly non-actionable prompt
    surfaces the transient error. A cloud outage no longer kills the turn.
  - **(C) Smarter `deriveActionableIntent`** (`lib/plan/deriveIntent.ts`):
    expanded stopwords (see/watch/look/catch/identify/what/he/she/they/…),
    per-word typo normalization (ingrdient/ingrediant/ingradient → ingredient),
    clean display-ready `scenarioLabels`, `format` defaults to "vertical",
    added `needsAnalysis`. Module is now import-free (inlined duration bounds)
    so it is unit-testable.
  - **(E) Clean labels** (`synthesizeVaguePlan`): builds scenarios from the
    intent's clean `scenarioLabels` (e.g. "ingredient-only moments",
    "cooking moments") instead of echoing the user's raw broken text in the
    "Looking for" list.
  - **(D) Auto-run** (`lib/types.ts` `autoRun?`, `app/api/agent/route.ts`,
    `app/editor/page.tsx`): the server sets `autoRun: true` on actionable
    direct-command plans when a video source exists; the client then runs the
    pipeline immediately instead of waiting for the "Run analysis" button (the
    button remains the manual fallback for no-video / non-actionable plans).
  - **(B) Static fallback** confirmed removed from all emit paths; only legacy
    detectors/comments reference the old string. New dead-ends use the
    context-aware `dynamicClarifyMessage`.
  - **(F) Tests** (`lib/plan/deriveIntent.test.ts` + `npm run test:intent`):
    Node built-in test runner (`--experimental-strip-types`, no new dep).
    7 cases incl. the two spec prompts, typo fix, no-static-fallback, and
    duration parsing. `tsconfig` excludes `**/*.test.ts`.
- **Files affected:** `app/api/agent/route.ts`, `lib/plan/deriveIntent.ts`,
  `lib/plan/deriveIntent.test.ts` (new), `lib/types.ts`, `app/editor/page.tsx`,
  `package.json`, `tsconfig.json`.
- **Reason:** Cloud-planner transient failures and imperfect prompts must
  still produce action, never a dead-end question or raw-text echo. No WebLLM
  changes. Verified `npm run typecheck`, `npm run build`, `npm run test:intent`
  all pass.

### 2026-06-13 — Agentic clarify: interpret imperfect prompts, kill the static topic question
- **Change made:** The planner no longer dead-ends on the static
  "I need a bit more before I can run the analysis — what should the short be
  about?" when the user already gave usable intent.
  1. **Planner prompt** (`lib/plan/prompt.ts`): added a step-0 "interpret
     imperfect/short prompts FIRST" rule to the clarify checklist. Broken
     grammar is read, not rejected. A content focus, a duration
     ("1min"/"1 min"/"one minute" → 60s + `userSpecifiedDuration`), or a scope
     word ("only"/"alone"/"just") makes a turn actionable → emit plan/moment,
     never a topic clarify. "only X" builds scenarios around X and pushes
     everything else into `avoid`. Includes the worked "ingredient part alone
     for 1min" example + the no-video upload-first message guidance.
  2. **Deterministic safety net** (`lib/plan/deriveIntent.ts`, NEW):
     `deriveActionableIntent(userText, ctx)` parses duration, content focus,
     `only/alone` exclusivity, generic exclusions, and format; plus
     `actionableIntentMessage(intent, hasVideo)` builds the dynamic reply
     ("Got it — I'll look for ingredient-only moments and build a 60s short…"
     / "Upload the video first, then I'll find the ingredient-only parts…").
  3. **Agent route** (`app/api/agent/route.ts`): the plan/moment-fail branch
     AND the direct `clarify` branch now consult `deriveActionableIntent`
     before asking anything — when actionable they synthesize a grounded plan
     (duration + focus + exclusions + format applied) and PROCEED. The old
     static string is removed; the remaining dead-end uses a context-aware
     `dynamicClarifyMessage(body)` (upload-first when no source).
     `synthesizeVaguePlan` gained an `intent?` param to apply the parsed
     duration/focus/avoid/format. New `hasVideoSource(body)` helper.
- **Files affected:** `lib/plan/prompt.ts`, `lib/plan/deriveIntent.ts` (new),
  `app/api/agent/route.ts`.
- **Reason:** "i need a ingredient part alone for 1min" carries focus +
  duration + scope; re-asking the topic read as broken. Prefer action over
  questions; ask at most one context-aware question only when a required
  decision is genuinely missing. Cloud provider routing (OpenRouter/Gemini/
  custom) unchanged; no WebLLM. Verified `npm run typecheck` (pass) + spot-
  checked the duration/focus parser on the spec's example prompts.

### 2026-06-13 — Optional WebLLM local-LLM fallback (text-only, opt-in)
- **Change made:** Re-introduced an OPTIONAL in-browser WebLLM planner as a
  second-tier fallback in the provider router: **cloud (/api/agent) → local
  WebLLM text planner → manual**. It is OFF by default and gated by three
  `NEXT_PUBLIC_LOCAL_LLM_*` flags + WebGPU.
  - New dep: `@mlc-ai/web-llm@^0.2.84`.
  - New modules under `lib/local-llm/`:
    - `config.ts` — reads `NEXT_PUBLIC_LOCAL_LLM_ENABLED` /
      `_AUTO_FALLBACK` / `_DEFAULT_MODEL` (default
      `Llama-3.2-1B-Instruct-q4f32_1-MLC`).
    - `status.ts` — tiny `useSyncExternalStore` pub/sub for the AI-mode
      indicator (cloud/local/manual + load progress); no web-llm import.
    - `webllm.ts` — lazy engine loader. `@mlc-ai/web-llm` is pulled in ONLY
      via `await import()` (separate chunk, never on page load); WebGPU
      checked up front; reports download/compile progress.
    - `localPlanner.ts` — `tryLocalPlannerFallback()` runs a compact
      text-only prompt → `extractJsonObject` → `normalizePlan`. Returns a
      plan, or `{ kind: "unsupported" }` for vision/describe asks (truthful),
      or null (→ manual).
  - `components/AIModeBadge.tsx` — header pill showing Cloud / Local AI
    loading NN% / Local AI / Manual. Wired into `AssistantPanel` header.
  - `app/editor/page.tsx` — `handleAgent` cloud-error branch now attempts the
    local recovery (lazy dynamic imports); on success it synthesizes a
    `mode:"plan"` response and continues the EXISTING pipeline unchanged. The
    describe/briefing cloud-vision failures append a truthful "local AI can't
    watch frames yet" note when the feature is enabled.
  - `lib/config.ts` CSP re-allows `raw.githubusercontent.com` (WebLLM model
    libs); `huggingface.co` (weights) was already allowed.
  - `.env.example` documents the three flags (all default false/off).
- **Files affected:** `package.json`, `lib/local-llm/*`,
  `components/AIModeBadge.tsx`, `components/AssistantPanel.tsx`,
  `app/editor/page.tsx`, `app/globals.css` (spin util), `lib/config.ts`,
  `.env.example`.
- **Reason:** Graceful degradation when the cloud planner is unavailable,
  WITHOUT re-coupling the app to the browser or breaking the manual editor.
  Scoped hard: text edit-planning only (no vision), lazy/opt-in, on-device
  (no API key, no NEXT_PUBLIC secret, no video upload).
- **Verified:** `npm run typecheck` and `npm run build` both pass. `/editor`
  first-load JS stayed at 159 kB — confirming web-llm is a lazy chunk, not in
  the initial bundle. Runtime model download/inference needs a real WebGPU
  browser (cannot be exercised in CI/sandbox).

### 2026-06-13 — Tighten OpenRouter max_tokens (tiered caps) + RE-APPLY transient retry
- **Change made:**
  1. **Tiered max_tokens safety caps** replace the single 4096 default.
     `lib/config.ts` OPENROUTER now has `plannerMaxTokens: 1200`,
     `visionMaxTokens: 1600`, and an absolute `hardMaxTokens: 2048` ceiling.
     `lib/providers/openrouter.ts` adds `hardMaxTokens()` (env
     `OPENROUTER_MAX_TOKENS` → config ceiling) and `clampMaxTokens()`;
     `attemptCompletion` ALWAYS clamps the final `max_tokens` to the ceiling,
     so a giant value (e.g. the model's 65535 window) can NEVER be sent —
     even the briefing's 3072 retry is clamped to 2048. `openrouterJson`
     defaults to the planner cap, `openrouterMultiImageJson` to the vision cap
     (via internal `fallbackMaxTokens`).
  2. **Re-applied the transient-retry-with-backoff** that was lost: PR #48
     merged at commit 76080a8 (token cap only); the retry commit (bc09dbe)
     was pushed to that branch AFTER the merge and never landed on main.
     `createCompletion` is again split into a retry loop + `attemptCompletion`
     with `isRetryableError` (429/5xx/overload/network) + `sleep`, governed by
     `OPENROUTER.retryAttempts` (3) / `retryBaseDelayMs` (600). Non-transient
     errors (400/401/402/403) and aborted requests are NOT retried.
- **Files affected:** `lib/config.ts`, `lib/providers/openrouter.ts`,
  `lib/env.ts`, `.env.example`.
- **Reason:** Harden against the 402 "requested up to 65535 tokens, but can
  only afford 16000" error with a guaranteed hard clamp (the previous 4096
  default was not a hard ceiling and vision callers could exceed it), and
  restore the transient-overload retry that is the intended primary fix for
  the temporary "vision model is temporarily overloaded" issue. Verified with
  `npm run typecheck` (pass). No test runner exists in the repo.

### 2026-06-13 — Fix OpenRouter 402 "requires more credits, or fewer max_tokens" on the planner
- **Change made:** OpenRouter calls now send a default `max_tokens` cap when
  the caller doesn't pass one. Added `OPENROUTER.maxTokens` (default **4096**)
  in `lib/config.ts`, a `OPENROUTER_MAX_TOKENS` env override (`lib/env.ts` +
  documented in `.env.example`), and a `defaultMaxTokens()` resolver in
  `lib/providers/openrouter.ts` that `createCompletion` falls back to.
- **Files affected:** `lib/config.ts`, `lib/env.ts`,
  `lib/providers/openrouter.ts`, `.env.example`.
- **Reason:** The planner (`cloudPlannerJson` → `openrouterJson`) never set
  `max_tokens`. When omitted, OpenRouter PRE-RESERVES credits for the model's
  full completion window (65535 tokens for the configured model), so
  low-credit accounts were rejected with **HTTP 402** before the request ran
  (*"requires more credits, or fewer max_tokens … requested up to 65535 …
  can only afford 16000"*). The planner emits a small JSON plan, so a 4096
  cap keeps the reserved budget affordable. Vision callers (e.g. briefing)
  pass their own larger `maxTokens`, which still wins. Verified with
  `npm install` + `npm run typecheck` (pass).

### 2026-06-11 — Document OpenRouter-only pin (single model: openai/gpt-5.5-pro)
- **Change made (config/docs only, no code logic change):** `.env.example`
  now documents a "pin everything to OpenRouter + one model" setup:
  `CLOUD_PROVIDER_ORDER=openrouter` and all four model slugs
  (`OPENROUTER_DEFAULT_MODEL` / `CHEAP` / `PREMIUM` / `OSS`) set to
  `openai/gpt-5.5-pro`. Added a note: this is for OpenRouter pinned to one
  model with NO fallback. Comments show how to revert to the multi-provider
  default (blank `CLOUD_PROVIDER_ORDER`, mixed model slugs).
- **No code changes needed:** the dispatcher already supports this via env.
  `configuredOrder()` parses `CLOUD_PROVIDER_ORDER` → `["openrouter"]`;
  `providerOrder()` filters out gemini/groq; with a single provider
  `attemptableOrder` returns `["openrouter"]`, so `cloudPlannerJson` /
  `cloudVisionJson` try ONLY OpenRouter and rethrow on failure — **no
  Gemini/Groq fallback**. All routes call the dispatcher with no model
  override, so they use `OPENROUTER_DEFAULT_MODEL` (= `openai/gpt-5.5-pro`).
- **Exact env the user sets OUTSIDE the repo** (.env.local / Vercel):
  `OPENROUTER_API_KEY=<secret>`, `CLOUD_PROVIDER_ORDER=openrouter`,
  `OPENROUTER_DEFAULT_MODEL=openai/gpt-5.5-pro` (+ CHEAP/PREMIUM/OSS same).
- **Security (verified):** `OPENROUTER_API_KEY` is read server-side only
  (`lib/env.ts`); there is NO `NEXT_PUBLIC_OPENROUTER_API_KEY`; the key is
  not in `.env.example`, the client bundle, or logs; providers never log
  prompts/base64 frames/keys; no browser WebLLM. Lib config defaults left
  unchanged (multi-provider) so only this deployment's env pins it.
- **Caveat:** this pins chat/planning (and vision IF `openai/gpt-5.5-pro` is
  multimodal on OpenRouter). It does NOT change transcription — Whisper still
  runs locally in-browser; no cloud transcription provider was added.
- **Files affected:** `.env.example`; `memory/*`.
- **Validation:** `npm run typecheck` ✓, `npm run build` ✓.

---

### 2026-06-11 — Self-healing IndexedDB (fix "object store was not found" crash)
- **Root cause:** Two issues produced `NotFoundError: Failed to execute
  'transaction' on 'IDBDatabase': One of the specified object stores was not
  found.` (1) **DB-name collision** — `lib/audio/cache.ts` opened
  `createStore("shorts-studio-cache", "transcripts")` while `lib/store/idb.ts`
  opened the same DB name with store `"kv"`; idb-keyval only ever creates the
  FIRST object store a DB sees, so whichever opened second crashed. (2)
  **Stale/partial DBs** (old builds, failed upgrades, dev hot-reloads) where a
  DB exists without the expected `kv` store. Both surfaced as a red
  "Something went wrong" bubble.
- **Fix:** Rewrote `lib/store/idb.ts` as a self-healing layer:
    - Each logical store has its OWN database (one object store per DB):
      `sessions` → `shorts-studio-sessions/kv`, `cache` →
      `shorts-studio-cache/kv`, `logs` → `shorts-studio-logs/kv`,
      `transcripts` → **`shorts-studio-transcripts/kv`** (NEW dedicated DB —
      removes the collision). `lib/audio/cache.ts` now uses it.
    - Lazy store creation (`stores` map). `withIdbRecovery(kind, op, fn)`
      runs the op; on a missing-object-store error it DROPS the cached
      (broken) store handle, deletes ONLY that database (`deleteDatabaseSafe`,
      waits for real completion with a 2s safety timeout), recreates the
      store fresh, and retries the op exactly once.
    - Helpers: `isMissingObjectStoreError`, `deleteDatabaseSafe`,
      `safeGet/safeSet/safeDel/safeKeys/safeUpdate`, `resetAllLocalDatabases`
      (emergency dev util), and `friendlyStorageError` →
      `STORAGE_CORRUPTED_MESSAGE`.
    - The public `idbSessions` / `idbCache` / `idbLog` API shape is UNCHANGED
      (now backed by the safe helpers), so `sessions.ts`, `cache.ts`, and
      `log/store.ts` needed no edits.
    - Editor + launch error sites now map a persistent storage-corruption
      error to the clean message "Local browser storage was corrupted. Please
      clear site data and reload." instead of the raw IDB exception.
- **Scope/safety:** Only the AFFECTED DB is deleted (not all storage); video/
  source state is untouched; recovery only `console.warn`s the DB name +
  operation — never logs stored values, video bytes, base64 frames, prompts,
  API keys, or transcript text.
- **Emergency snippet (documented for support):**
  `["shorts-studio-sessions","shorts-studio-cache","shorts-studio-logs","shorts-studio-transcripts"].forEach(n=>indexedDB.deleteDatabase(n)); location.reload();`
- **Files affected:** `lib/store/idb.ts`, `lib/audio/cache.ts`,
  `app/editor/page.tsx`, `app/launch/page.tsx`; `memory/*`.
- **Validation:** `npm run typecheck` ✓, `npm run build` ✓. Browser
  corruption test still pending (no browser in sandbox).

---

### 2026-06-11 — Dynamic duration: removed forced/default 30s (explicit-only)
- **Change made:** Final clip length is now **explicit-only**. When the user
  does NOT name a duration, the app does not force or display 30s — selection
  runs the quality-floor path and total length is **emergent** from clip
  quality. When the user names a duration ("30 second reel", "make it 15s",
  "1 minute highlight"), `userSpecifiedDuration=true` + `targetShortSeconds`
  is parsed and the budgeted fit/trim runs. The pipeline already branched on
  `userSpecifiedDuration` (highlights.ts quality-floor vs budgeted;
  mergeAcrossSources skips budget when false) — this change removes the
  remaining places that *forced/showed* 30s when the user hadn't asked:
    - `lib/plan/prompt.ts` — D1 rewritten: "NEVER ASSUME 30 SECONDS";
      platform words (TikTok / YouTube Short / Instagram) imply FORMAT
      (vertical) only, never a duration; added parse examples (15s→15,
      "1 minute"→60, 1m30s→90, 0:45→45) and the "make it tighter" rule;
      removed the anti-loop example that forced `targetShortSeconds:30` + the
      "30s action reel" message; clarify chip "Make a 30s highlight reel" →
      "Make a highlight reel"; good-message exemplar no longer says "30s";
      promote `targetSeconds` documented as explicit-only; the rendered
      "Current plan" line now says `target=flexible (no user-set duration)`
      unless the user set one.
    - `app/api/agent/briefing/route.ts` — the vision SYSTEM prompt now tells
      the model NOT to bake a duration into follow-up chips ("no 30s/15s
      reel") unless asked; the no-follow-ups fallback is "Make a highlight
      reel of these moments".
    - `components/PlanPreview.tsx` — shows `{target}s` only when the user set
      a duration, else "flexible length".
    - `components/AssistantPanel.tsx` — starter chip "Make a 30s vertical
      reel" → "Make a vertical reel".
    - `app/editor/page.tsx` — the `plan.created` activity-log summary shows
      "flexible length" instead of "30s" for no-duration plans.
    - `hooks/useEditorStore.ts` — `memoryFromPlan` only persists
      `memory.duration` when `userSpecifiedDuration` is true, so the soft
      fallback (30) can no longer resurface as a phantom "30s preference" in
      the planner's memory block on later turns.
    - `lib/config.ts` — `PLAN_DEFAULTS.targetShortSeconds` (30) commented as a
      SOFT, NON-ENFORCED fallback only.
- **Promote/briefing:** "clip those" / "use these moments" / "make a reel
  from these" carry NO `targetSeconds` (natural clip lengths preserved);
  "make a 15s reel of these" sets `targetSeconds=15`. No default `30`.
- **OpenRouter setup verified unchanged + server-only:** `OPENROUTER_API_KEY`
  read only in `lib/env.ts` (no `NEXT_PUBLIC_OPENROUTER_API_KEY`),
  `OPENROUTER_DEFAULT_MODEL` defaults `google/gemini-2.5-flash`,
  `CLOUD_PROVIDER_ORDER` server-only toggle works, order OpenRouter → Gemini →
  Groq, vision excludes Groq, PR #43 circuit fallback intact, no browser
  WebLLM, no key/prompt/base64 logging.
- **Files affected:** `lib/plan/prompt.ts`, `lib/config.ts`,
  `app/api/agent/briefing/route.ts`, `components/PlanPreview.tsx`,
  `components/AssistantPanel.tsx`, `app/editor/page.tsx`,
  `hooks/useEditorStore.ts`; `memory/*`.
- **Reason:** A no-duration request should produce a natural-length reel
  driven by footage quality, not a forced 30s. Explicit durations still fit.
- **Validation:** `npm run typecheck` ✓, `npm run build` ✓.

---

### 2026-06-11 — Add CLOUD_PROVIDER_ORDER env var to toggle/re-order providers
- **Change made:** Added an optional **server-only** `CLOUD_PROVIDER_ORDER`
  env var so you can toggle between providers (and set fallback order)
  without code changes or removing API keys. Comma-separated provider names
  (`openrouter | gemini | groq`); e.g. `CLOUD_PROVIDER_ORDER=gemini` forces
  Gemini only, `=openrouter` forces OpenRouter only, `=gemini,openrouter`
  prefers Gemini with OpenRouter fallback. Unknown/duplicate tokens are
  ignored; unset → the config default (`openrouter,gemini,groq`).
  - `lib/env.ts` — read `CLOUD_PROVIDER_ORDER` into `serverEnv` (server-only,
    not `NEXT_PUBLIC_*`).
  - `lib/providers/cloud.ts` — new `configuredOrder()` (env override →
    config default, validated/deduped) feeds `providerOrder()`. A provider is
    still only used if its key is set; Groq stays text-only (skipped for
    vision); per-provider circuit recording unchanged.
  - `.env.example` — documented the toggle with examples.
- **Files affected:** `lib/env.ts`, `lib/providers/cloud.ts`, `.env.example`;
  `memory/*`.
- **Reason:** Let the operator switch between OpenRouter and Gemini (or pin a
  single provider) at deploy time without editing code.
- **Validation:** `npm run typecheck` ✓, `npm run build` ✓. No browser WebLLM;
  keys remain server-only; no new logging.

---

### 2026-06-11 — Fix: provider circuit-open no longer blocks Gemini/Groq fallback
- **Change made:** The route-level circuit pre-check could 503 a request when
  the **primary** provider's circuit was open — before the dispatcher could
  try the fallbacks. Fixed so the dispatcher owns circuit handling:
  - `lib/ratelimit/index.ts` — Layer 4 (provider circuit breaker) is now
    **opt-in**: it only runs (and can block) when a caller passes an explicit
    `provider`. Dispatcher-backed routes omit it. Session (Layer 2) + global
    budget (Layer 3) checks are unchanged and still apply.
  - `lib/providers/cloud.ts` — new `attemptableOrder()` filters
    `CLOUD_PROVIDER_ORDER` by circuit state: **skips circuit-open providers**
    and tries the next configured one; if EVERY provider's circuit is open it
    falls back to the full configured order (best-effort, self-healing).
    `cloudPlannerJson` / `cloudVisionJson` use it; success/failure is still
    recorded per **actual** provider attempted.
  - `app/api/agent/route.ts`, `app/api/agent/briefing/route.ts`,
    `app/api/vision/clip/route.ts` — dropped the `provider: primaryProvider()`
    arg from `checkAllLimits` (+ removed the now-unused import) so an open
    primary circuit can't 503 before fallback.
  - `app/api/vision/frame` + `/api/vision/window` (Gemini-direct, single
    provider, no fallback) keep passing `provider: "gemini"` → their fast-fail
    behaviour is unchanged.
- **Result:** With OpenRouter primary + Gemini/Groq configured, an OpenRouter
  outage/open-circuit now falls back (text → Gemini → Groq; vision → Gemini)
  instead of returning 503. Groq stays text-only (excluded from vision).
- **Files affected:** `lib/ratelimit/index.ts`, `lib/providers/cloud.ts`,
  `app/api/agent/route.ts`, `app/api/agent/briefing/route.ts`,
  `app/api/vision/clip/route.ts`; `memory/*`.
- **Reason:** A circuit breaker on the primary should reroute to a healthy
  fallback, not fail the whole request.
- **Validation:** `npm install` ✓, `npm run typecheck` ✓, `npm run build` ✓.
  No browser WebLLM reintroduced; keys still server-only; no prompt/base64/key
  logging. Live forced-failure fallback test pending (no API keys in sandbox).

---

### 2026-06-11 — Removed browser WebLLM; cloud routing via server-side OpenRouter
- **Change made:** Retired the in-browser WebLLM / WebGPU local language +
  tool-routing path and replaced cloud language/tool routing with a
  **server-side OpenRouter** provider (Gemini/Groq kept as fallbacks).
  - **Removed:** the entire `lib/llm/*` (engine, chat, tools, localFirst,
    grounding, prompt, types, index, `webllm.worker.ts`); the
    `@mlc-ai/web-llm` dependency; `LOCAL_LLM` + `LOCAL_FIRST` config; the
    `NEXT_PUBLIC_LOCAL_FIRST_EDITOR` flag + the editor's local-first gate +
    `executeLocalFirstAction`; the CSP `raw.githubusercontent.com` entry
    (only there for WebLLM model libs); and the one-time
    `.github/workflows/apply-local-first-once.yml` (which re-injected the
    WebLLM wiring). No more in-browser model download.
  - **Added:** `lib/providers/openrouter.ts` — server-only,
    OpenAI-compatible client (`openrouterJson`, `openrouterMultiImageJson`);
    `Authorization: Bearer OPENROUTER_API_KEY`, `X-Title: Shorts Studio`,
    optional `HTTP-Referer` (APP_URL / NEXT_PUBLIC_APP_URL); JSON-object mode
    + `extractJsonObject` parse fallback. Plus `lib/providers/cloud.ts` — a
    dispatcher (`cloudPlannerJson`, `cloudVisionJson`, `primaryProvider`)
    that walks `CLOUD_PROVIDER_ORDER = ["openrouter","gemini","groq"]`, skips
    providers with no key (Groq excluded from vision), and records each
    provider's circuit success/failure. New `OPENROUTER` config block; new
    env (`OPENROUTER_API_KEY`, `OPENROUTER_DEFAULT_MODEL=google/gemini-2.5-flash`,
    `OPENROUTER_CHEAP_MODEL=google/gemini-2.5-flash-lite`,
    `OPENROUTER_PREMIUM_MODEL=anthropic/claude-sonnet-4.5`,
    `OPENROUTER_OSS_MODEL=qwen/qwen3-coder`, `APP_URL`); `hasOpenRouter()` +
    `hasAnyVisionProvider()`; `Provider` circuit type gains `"openrouter"`.
  - **Routes:** `/api/agent` planner JSON now goes through `cloudPlannerJson`
    (OpenRouter→Gemini→Groq), preserving `normalizePlan` + every mode
    (clarify/briefing/promote/extract/edit/merge/describe). `/api/agent/briefing`
    and `/api/vision/clip` use `cloudVisionJson` (OpenRouter multimodal →
    Gemini direct); the briefing retry/minimal-fallback logic is intact.
- **Security (hard rules honoured):** the OpenRouter key is **server-only**
  (`serverEnv.OPENROUTER_API_KEY`); there is **no** `NEXT_PUBLIC_OPENROUTER_API_KEY`;
  verified the key name + `openrouter.ai` do **not** appear in the client
  bundle (`.next/static`); providers never log the key, prompts, or base64
  frames. Full video bytes still never leave the browser — only the
  already-sampled frames go to the cloud vision routes (destination can now
  be OpenRouter instead of Google directly).
- **Honesty:** OpenRouter does NOT fully replace Gemini vision — it handles
  vision only when the configured model is multimodal (the default
  `google/gemini-2.5-flash` is); otherwise it falls back to direct Gemini.
  No fake frame-tree/caption/vision data was added. The app is **no longer
  offline / local-LLM** — language routing is cloud-only now.
- **Kept (deterministic, non-model client paths):** structured briefing
  follow-ups (`lib/briefing/followups.ts`, `hooks/useBriefingActions.ts`),
  the grammar quick-shortcut gate (`lib/intent/*`), and promote/extract/reset
  (via the cloud planner's modes + existing client handlers).
- **Files affected:** `lib/providers/openrouter.ts` (new),
  `lib/providers/cloud.ts` (new), `lib/config.ts`, `lib/env.ts`,
  `lib/ratelimit/circuit.ts`, `app/api/agent/route.ts`,
  `app/api/agent/briefing/route.ts`, `app/api/vision/clip/route.ts`,
  `app/editor/page.tsx`, `package.json`, `package-lock.json`, `.env.example`,
  deleted `lib/llm/*` + the apply-local-first workflow; `memory/*`.
- **Reason:** WebLLM meant multi-GB browser downloads, WebGPU/device
  instability, and poor universal support; a server-side OpenRouter API is
  simpler, universal, and keeps keys off the browser.
- **Validation:** `npm install` ✓ (removed 2 packages), `npm run typecheck` ✓,
  `npm run build` ✓ (only the pre-existing `@huggingface/transformers`
  `import.meta` warning; `/editor` bundle 47.8 → 47.2 kB). Live OpenRouter
  calls + browser manual tests NOT run here (no key / browser in sandbox).

---

### 2026-06-11 — Local-first high-tier model → Hermes-3-Llama-3.1-8B (agentic/tool-use)
- **Change made:** Re-tiered the local WebLLM model choices in
  `lib/config.ts` (`LOCAL_LLM`) so the high tier prefers a model WebLLM
  explicitly supports for function-calling/tool-use:
    - **high:** `Hermes-3-Llama-3.1-8B-q4f16_1-MLC` (was
      `Qwen2.5-3B-Instruct-q4f16_1-MLC`) — Hermes-3 is on WebLLM's
      `functionCallingModelIds` list (verified against the prebuilt
      `model_list`; ~4.9 GB VRAM, `low_resource_required: false`), so the
      flag-gated local tool router (`lib/llm/tools.ts`) gets more reliable
      JSON tool decisions.
    - **mid:** `Qwen2.5-3B-Instruct-q4f16_1-MLC` (the previous high-tier
      model, kept as a strong/lighter fallback).
    - **low:** `Llama-3.2-1B-Instruct-q4f16_1-MLC` (unchanged).
    - Dropped the old `Qwen2.5-1.5B-Instruct-q4f16_1-MLC` mid entry.
  Added an **additive** `roles` metadata block
  (`agenticToolModel`/`fastPlannerModel`/`tinyFallbackModel`) for
  documentation + future allowlisting; the runtime tier→model selectors in
  `lib/llm/engine.ts` and `lib/llm/tools.ts` still read
  `modelHigh`/`modelMid`/`modelLow` directly, so the runtime stays simple and
  unchanged. Comments document the Hermes rationale, the Qwen mid fallback,
  and the **vision caveat**.
- **What did NOT change (by design):** Gemini is **not** removed — it remains
  the cloud planner AND the **vision briefing** fallback. These local LLMs do
  language/tool routing only; they do **not** replace Gemini vision. Full
  Gemini-optional requires REAL local frame-tree + caption grounding
  (`lib/frame-tree`, `lib/vision/caption*`, `lib/vision-core`) to be wired —
  no fake frame/vision data was added. `NEXT_PUBLIC_LOCAL_FIRST_EDITOR`
  default stays **OFF**; the cloud fallback path is byte-for-byte unchanged.
  `app/api/agent/briefing`, ffmpeg/render/scoring/sampling, and Phase 5 were
  intentionally untouched.
- **Files affected:** `lib/config.ts` (`LOCAL_LLM` only); `memory/*`.
- **Reason:** Better agentic/tool-use behaviour on the local-first path by
  using a model WebLLM officially supports for function-calling, without
  weakening or removing the cloud Gemini flow.
- **Validation:** `npm install` ✓, `npm run typecheck` ✓, `npm run build` ✓
  (see CHANGELOG validation note / final report for status). Hermes-8B
  loading + tool-routing quality is NOT verified here — needs a real WebGPU
  browser with `NEXT_PUBLIC_LOCAL_FIRST_EDITOR=true` (no GPU in sandbox).

---

### 2026-06-11 — Briefing endpoint: retry-once + minimal fallback (resilience fix)
- **Change made:** Fixed the live bug where "Describe what's in this video"
  could dead-end on *"The video summary came back incomplete…"* whenever
  Gemini reached the endpoint but returned text `extractJsonObject()` couldn't
  parse (truncated/wrapped JSON from thinking-heavy/overloaded models).
  `app/api/agent/briefing/route.ts` now:
  1. **Retries once** when the first parse fails — with **fewer frames**
     (`selectRetryFrames`: first + last + evenly-spaced middle, capped at
     `RETRY_FRAME_CAP = 8`) and a **stricter, compact prompt** (`STRICT_SYSTEM`:
     JSON-only, overview ≤ 40 words, ≤ 3 best parts, ≤ 3 follow-ups) at a
     higher output cap (`RETRY_MAX_OUTPUT_TOKENS = 3072`).
  2. **Degrades to a minimal fallback `BriefingResult`** (HTTP 200, no `error`)
     when the retry also can't be parsed OR the retry call throws — so the UI
     renders a real briefing card (overview + "Try a smaller window" /
     "Pick the best parts for me" chips) instead of only an error bubble.
  3. **Hard error only** when the FIRST Gemini call fails or the request is
     invalid (unchanged).
  4. **Safe logging:** parse failures log the model text truncated to 300
     chars + its length via `console.warn`; never image/base64 or video bytes.
  - Extracted helpers: `selectRetryFrames`, `buildBriefingPrompt`,
    `parseBriefingJson`, `framesToImages`, `fallbackBriefing`, and two log
    helpers. No UI, ffmpeg/render/scoring, or Phase 5 changes. Video privacy
    unchanged — only the already-sampled frames are sent; no new upload path.
- **Files affected:** `app/api/agent/briefing/route.ts`, `memory/*`.
- **Reason:** Make the briefing resilient to incomplete/non-JSON Gemini output.
- **Validation:** `npm install` ✓, `npm run typecheck` ✓, `npm run build` ✓.
  CI (typecheck + build) will run on the PR. Browser/WebGPU + live-Gemini
  manual testing still required (no Gemini key / GPU in the build sandbox).

---

### 2026-06-11 — Add GitHub Actions CI + CHANGELOG formatting cleanup
- **Change made:**
  1. **CI workflow added** (`.github/workflows/ci.yml`). Runs on
     `pull_request` targeting `main` and on `push` to `main`: Ubuntu latest,
     Node 20 with npm cache, installs via `npm ci` (lockfile present, else
     `npm install`), then `npm run typecheck` and `npm run build`. Lint is
     intentionally NOT run — there is no ESLint config and `next lint` prompts
     interactively, which would hang CI. So future merges are gated on
     typecheck + build.
  2. **CHANGELOG formatting cleanup.** Restored two `###` headings that had
     been dropped by earlier chained edits (the "Structured briefing
     follow-ups + safe local-first actions" and "Editor syntax/typecheck fix"
     entries) and added the missing `---` separators, so each entry is again
     readable as a discrete dated block. No meaning changed.
- **Files affected:** `.github/workflows/ci.yml` (new), `memory/CHANGELOG.md`,
  `memory/PROJECT_STATE.md`, `memory/TODO.md`, `memory/CONSTRAINTS.md`.
- **Reason:** Production hygiene — automatically validate PRs, and keep the
  memory handoff brain clean for future agents.
- **Validation:** `npm install` ✓, `npm run typecheck` ✓, `npm run build` ✓
  (only the pre-existing `@huggingface/transformers` `import.meta` warning).
  CI workflow run status to be confirmed after the PR opens. Browser/WebGPU
  runtime still NOT verified — manual browser testing required.

---

### 2026-06-11 — Phase 4.5 sourceId polish + Phase 5 first hook extraction
- **Change made:**
  1. **Phase 4.5 polish — briefing `plan_topic` actions preserve `sourceId`.**
     When a briefing was created from one specific source in a multi-source
     project, clicking a topic chip could build a plan that ran across ALL
     selected sources. The client-side plan now passes
     `sources: [action.sourceId]` into `normalizePlan()` (which already
     sanitizes `sources`), so the run stays grounded on the source that was
     actually briefed. No `/api/agent` call; no genre/category logic. When a
     follow-up has no `sourceId`, behavior is unchanged. The `plan.created`
     activity log now records the locked `sources`.
  2. **Phase 5 (first extraction) — `hooks/useBriefingActions.ts`.** Moved the
     deterministic briefing follow-up handler (`promote` / `plan_topic` /
     `extract_range`, plus their logging + status/progress updates) out of the
     ~2000-line `app/editor/page.tsx` into one focused, behavior-identical
     hook. The page now calls `useBriefingActions({...})` and supplies the
     store setters/loggers it owns; the hook reuses the same store actions
     (`promoteBriefingParts`, `buildExtractedHighlight`, `normalizePlan`,
     `mergeHighlights`/`setHighlights`, `setPlan`/`setMode`/
     `setPendingExecution`/`setPendingClarify`). `chat` follow-ups still route
     through the normal chat pipe in `AssistantPanel`. No behavior change.
- **Files affected:** `hooks/useBriefingActions.ts` (new),
  `app/editor/page.tsx` (replaced the inline `handleBriefingAction` with the
  hook call; dropped now-unused `normalizePlan` / `SIGNAL_DEFAULTS` /
  `BriefingFollowUp` imports), `memory/*`.
- **Reason:** Keep multi-source briefings grounded (correctness), and begin
  Phase 5 maintainability with ONE low-risk, behavior-preserving extraction
  (no big refactor, no feature mixing).
- **Validation:** `npm install` ✓, `npm run typecheck` ✓, `npm run build` ✓
  (only the pre-existing `@huggingface/transformers` `import.meta` warning;
  `/editor` bundle unchanged at ~47.8 kB). `npm run lint` still NOT configured
  (`next lint` prompts for interactive setup). Browser/WebGPU runtime and the
  multi-source manual checks (plan locked to `sources:[briefingSourceId]`,
  Run analysis uses the intended source) still need a real browser. No CI run.

---

### 2026-06-11 — Structured briefing follow-ups + safe local-first actions
- **Change made:**
  1. **Structured briefing follow-ups (Phase 3 — now done).** Replaced the
     plain-string follow-up chips with an intent-carrying
     `BriefingFollowUp` union (`promote` | `plan_topic` | `extract_range` |
     `chat`). Briefing chips no longer round-trip through the cloud planner
     as raw text, which is what caused the "what should the short be about?"
     clarify loop. New pure normalizer `lib/briefing/followups.ts` upgrades
     legacy/string follow-ups into actions (generic "use these moments"
     heuristic → `promote`; otherwise `plan_topic` grounded in the briefing;
     NO genre/keyword tables). `BriefingResult.followUps` now accepts
     `Array<string | BriefingFollowUp>` (backward compatible with the
     briefing API and old saved sessions). `BriefingCard` + `AssistantPanel`
     dispatch structured actions; the editor runs them deterministically
     (promote → `promoteBriefingParts`; plan_topic → client-side
     `normalizePlan` + pending execution, never clarify; extract_range →
     `buildExtractedHighlight`). `chat` still goes through the normal pipe.
  2. **Phase 4.5 — safe deterministic local-first actions.** `localFirst.ts`
     now executes a closed set of low-risk router decisions on-device behind
     the flag: `promote`, `extract`, `reset` (each maps onto an existing
     tested store path / pure builder, above `LOCAL_FIRST.minActionConfidence`).
     `plan`/`moment`/`edit`/`merge`/`describe` and any low-confidence/missing-
     data case still FALL THROUGH to the unchanged cloud planner (no faked
     frame-tree/vision data). `chat` local handling is unchanged.
- **Files affected:** `lib/types.ts` (BriefingFollowUp + BriefingResult),
  `lib/briefing/followups.ts` (new), `lib/config.ts`
  (`BRIEFING_FOLLOWUP`, `LOCAL_FIRST.minActionConfidence`),
  `components/BriefingCard.tsx`, `components/AssistantPanel.tsx`,
  `app/editor/page.tsx` (`handleBriefingAction`, `executeLocalFirstAction`,
  local-first gate), `lib/llm/localFirst.ts`; `memory/*`.
- **Reason:** Make briefing chips product-quality (carry intent, run
  deterministically) and complete the safe slice of local-first action
  execution without breaking the cloud flow.
- **Validation:** `npm install` ✓, `npm run typecheck` ✓, `npm run build` ✓
  (only a pre-existing `@huggingface/transformers` `import.meta` warning).
  `npm run lint` is NOT separately configured in this repo (`next lint`
  prompts for interactive setup; eslint deps exist but no config file) — the
  build's own type+lint pass is green. Browser/WebGPU runtime (local router
  executing actions) NOT verified — no GPU in sandbox; needs a real browser
  with `NEXT_PUBLIC_LOCAL_FIRST_EDITOR=true`. No CI workflow run.

---

### 2026-06-11 — Editor syntax/typecheck fix
- **Change made:** Removed a duplicated quick-shortcut `catch` block in
  `app/editor/page.tsx` that caused TypeScript parser errors and cascade
  declaration errors.
- **Files affected:** `app/editor/page.tsx`, `memory/PROJECT_STATE.md`,
  `memory/TODO.md`, `memory/CHANGELOG.md`.
- **Reason:** Restore a clean `tsc --noEmit` check without changing editor
  behavior.
- **Validation:** `npm.cmd run typecheck` passes.

### 2026-06-10 — Clarify-branch briefing guard + narrowed plan synthesis
- **Change made:** (Bug 1) The `mode === "clarify"` branch in
  `app/api/agent/route.ts` now also synthesizes a briefing-grounded plan
  when a briefing is in scope AND the user gave a topic — previously only
  the plan/moment branch did this, so a direct LLM `mode:"clarify"` could
  still ask "what should the short be about?" after a briefing chip.
  (Bug 2) `synthesizeVaguePlan` no longer adds every best-part label as a
  separate ~equal scenario (which diluted specific requests). It now builds
  ONE scenario = user text + a compact context phrase from ≤3 best-part
  labels, with semantic-heavy signals (0.65/0.2/0.15). New `SYNTH_PLAN`
  config constants (no magic numbers). Also corrected stale memory: PR #33
  is MERGED, not open.
- **Files affected:** `app/api/agent/route.ts`, `lib/config.ts`;
  `memory/PROJECT_STATE.md`, `memory/TODO.md`, `memory/CHANGELOG.md`.
- **Reason:** Close the remaining clarify hole and stop specific briefing
  follow-ups from being broadened into wrong clips. Deterministic safety
  around the LLM; generic (no genre/keyword tables).
- **Validation:** typecheck ✓, production build ✓, 8/8 logic unit checks ✓.
  Browser/GPU not verified (sandbox has no GPU).

### 2026-06-10 — Briefing follow-up clarify fix (PR #33) + memory sync
- **Change made:** Fixed the P0 bug where tapping a briefing follow-up chip
  (e.g. "Show all ingredient preparation clips") could return the generic
  "what should the short be about?" clarify. The plan/moment fallback in
  `app/api/agent/route.ts` now synthesizes a plan when a briefing is in scope
  AND the user gave a topic (not only after a prior clarify), grounding the
  scenario in the user's text + the briefing's best-part labels. Also
  corrected this memory: #28/#29/#30 are now confirmed MERGED to main (the
  earlier "still open" note was stale).
- **Files affected:** `app/api/agent/route.ts` (PR #33);
  `memory/PROJECT_STATE.md`, `memory/CHANGELOG.md`, `memory/TODO.md`,
  `memory/CONSTRAINTS.md` (this sync).
- **Reason:** Briefing chips always carry a concrete topic and the app
  already knows the video — re-asking was wrong. Deterministic safety around
  the LLM so product-critical UX doesn't depend only on prompt obedience.
- **Open:** PR #33 (not yet merged). **Merged since last entry:** #28
  (temporal fix), #29 (frame-tree), #30 (captioning).

### 2026-06-10 — Local chat/tool system merged to main; memory synced
- **Change made:** The capable local-first language layer landed on `main`:
  WebLLM engine + streaming chat + model-driven **tool router** (replaces the
  keyword/regex intent matching) + briefing "why" grounding, plus the
  deterministic `lib/vision-core` engine. Synced the memory files to reflect
  this (PROJECT_STATE status/module-table/next-step, TODO).
- **Files affected:** `lib/llm/*`, `lib/vision-core/*` (code, prior PRs);
  `memory/PROJECT_STATE.md`, `memory/TODO.md`, `memory/CHANGELOG.md` (this
  sync).
- **Reason:** Memory had gone stale — it still said the local-first modules
  were "on PRs / not on main." They are now merged (UI wiring still pending).
- **Still open (not on main):** PR #28 temporal-pass fix, #29 frame-tree,
  #30 captioning.

### 2026-06-08 — Add persistent project-memory system
- **Change made:** Created the `memory/` knowledge base (INDEX, PROJECT_STATE,
  DECISIONS, CONSTRAINTS, ROADMAP, TODO, CHANGELOG) and added an AI operating
  protocol to `AGENTS.md`.
- **Files affected:** `memory/*.md`, `AGENTS.md`.
- **Reason:** Let future AI sessions read repo context first and continue from
  the correct state. Documentation only — no application code changed.

> Add new entries above this line as changes happen.


### 2026-06-13 — Multi-source COMPOSE (montage) mode — Option A
- **Change made:** New first-class agent mode `compose` for combining picked
  moments from MORE THAN ONE uploaded video into a fresh ordered montage
  ("combat in the first video and the cutscene in the second, make it
  transition"). Distinct from `merge` (whole videos, no scoring) and `plan`
  (one score-fused reel). **Option A (chosen with the user):** the montage is
  built onto the single shared timeline via `setHighlights` (which snapshots
  the prior timeline → one-tap `undo`); original uploads are never mutated;
  source order is preserved unless the user asks shuffle/interleave; the run
  carries a visible label ("AI Combined 1"). A true second timeline slot
  (Option B) is deferred to a future timeline-architecture change.
  - **Types** (`lib/types.ts`): added `"compose"` to `IntentMode`; new
    `MultiSourceComposePlan` (+ `ComposeSourceRef`/`ComposeSourceSelection`/
    `ComposeOrdering`/`ComposeTransition`/`ComposeRole` types) and a
    `{ mode: "compose"; compose; autoRun? }` `AgentResponse` variant.
  - **Server** (`app/api/agent/route.ts`): `resolveMode` accepts `"compose"`
    + shape-detects `compose.sources`; new compose branch sanitises via
    `normalizeComposePlan`, sets `autoRun` when a video exists, falls back to
    a focused clarify when no usable picks parse.
  - **Pure resolvers** (import-free, `import type` only, unit-tested):
    `lib/plan/composeNormalize.ts` (defensive envelope clamp),
    `composeResolve.ts` (first/second/active/selected/id/filename+semantic
    hint → live library; ambiguous-fallback dedupe), `composeOrder.ts`
    (source_order / user_mentioned_order / interleave / shuffle / story_arc /
    energy_curve + `anchorFirst`; seeded `makeRng` for deterministic shuffle),
    `composeTransition.ts` (auto per-boundary by topic + honest down-map of
    glitch/whip/zoom/match_cut → renderable none/fade/crossfade).
  - **Sub-plan** (`lib/plan/composeSubPlan.ts`, config-aware): turns each
    source's `query` into a single-source `EditPlan` so picks run through the
    REAL `executeForSource` pipeline (no faked vision).
  - **Client** (`app/editor/page.tsx`): compose branch resolves sources, runs
    per-source analysis, trims by clipCount/durationSeconds, orders, assigns
    transitions, replaces the timeline, switches active source, and writes an
    honest summary (incl. a note when a fancy transition was mapped down, and
    when some named videos couldn't be matched).
  - **Prompt** (`lib/plan/prompt.ts`): new `## compose` section (when to pick
    compose vs merge vs plan; source-ref mapping; ordering/transition rules;
    user's example prompts; output schema). Fixed stale "five modes" copy.
  - **Tests/CI:** `lib/plan/compose.test.ts` (22 cases), `npm run test:compose`
    + combined `npm test`; CI gains a Node 22 `unit-tests` job (the built-in
    runner needs `--experimental-strip-types`).
- **Files affected:** `lib/types.ts`, `app/api/agent/route.ts`,
  `lib/plan/prompt.ts`, `app/editor/page.tsx`, `lib/plan/composeNormalize.ts`
  (new), `composeResolve.ts` (new), `composeOrder.ts` (new),
  `composeTransition.ts` (new), `composeSubPlan.ts` (new),
  `lib/plan/compose.test.ts` (new), `package.json`, `.github/workflows/ci.yml`.
- **Reason:** Users assigning different intents to different uploads needed a
  real montage path instead of a single insert/merge. Verified: `npm install`,
  `npm run typecheck`, `npm run build` all pass; `npm test` = 29 pass,
  `npm run test:compose` = 22 pass. Browser/WebGPU + live-API runtime
  verification of the per-source vision run is still MANUAL (sandbox has no GPU
  or keys).

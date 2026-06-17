# Agentic intent layer — 2026-06-17

> Net-new deterministic agent layer that turns natural editing commands
> into structured timeline operations BEFORE the cloud planner. Additive
> and reversible; the existing quick-shortcut gate + cloud planner remain
> the fallback. Local-first; no video upload; keys server-only.

## Why

The editor behaved like a command bot for anything past the narrow
`quickMatch` patterns. The goal is an editing ASSISTANT that understands
source/clip/range/concept references, placement, append-vs-replace-vs-
move-vs-remove, observed memory, and reinforcement — only asking to
clarify when genuinely ambiguous, with NO hidden hardcoded clip-count or
forced duration.

## What was built (staged modules)

### Phase 1 — `lib/intent/` command parsing (deterministic-first)
- `command.ts` — `EditCommand` union (`add_range | add_concept |
  add_clip_ref | move_clip | remove_clip | replace_clip | extend_clip |
  trim_clip | reorder | render`) + `SourceRef / ClipRef / TimeRangeSpec /
  PlacementSpec / RangeOrConceptSpec`, `AgentCommandContext`,
  `ParsedCommandResult`. (Separate file from the existing `types.ts`
  `QuickMatch` envelope — neither clobbers the other.)
- `timeRangeParser.ts` — `parseTimeRangeSpec` (unresolved spec) +
  `resolveTimeRange` (→ `{start,end,exact}`). first/last/middle N, first/
  second half, the middle part, absolute `1:20 to 2:10`, before/after T,
  `N sec before/after clip`. Reuses `time.ts` (`parseTimestamp` /
  `parseNumber`).
- `sourceResolver.ts` — `parseSourceRef` + `resolveSource`: one video →
  assume it; named → use it; multi + active/last-used → medium-confidence
  + surfaced assumption; else clarify. Fuzzy filename match.
- `clipResolver.ts` — `parseClipRef` + `resolveClip` (clip N, first/last,
  selected, last-created, anaphora, clip N from video M).
- `placementResolver.ts` — `parsePlacementSpec` + `resolvePlacement` →
  insertion index (after/before/between clip, at start/end).
- `editCommandParser.ts` — `parseEditCommand` → `ParsedCommandResult`;
  conservative (returns null → fall through to quickMatch + cloud).

### Phase 2 — `lib/agent-memory/`
- `types.ts` — `AgentMemoryRecord` (kind/key/value/confidence/evidence/
  source/scope), `FlowMemory`, `ReinforcementMemory`.
- `store.ts` — in-memory `AgentMemoryStore` (upsert reinforces; recall;
  flow; reinforcement) + `serialize/hydrate` (no idb import in core).
- `observer.ts` — extracts user-stated/preference/reinforcement facts
  (avoid intro, prefer action, exact ranges, no-hardcoded-clip-count,
  clip added/removed/liked, source preference) — every observed record
  carries confidence + evidence; user-stated outrank inferences.
- `resolver.ts` — anaphora signals + flow-based clip/source/concept
  resolution (it/that/this/same/again/more like this/after that).
- `policy.ts` — `decideAction` (execute ≥0.85 / note ≥0.65 / clarify) +
  `combineConfidence`. Thresholds in `lib/config.ts` (`AGENT_POLICY`).
  Imports config via relative path so it runs under `node --test`.
- `context.ts` — compact relevant-only snapshot/render for prompts.

### Phase 3 — `lib/timeline/`
- `placement.ts` — pure index math (insert/append/prepend/move/clamp).
  NOTE: store `setHighlights` does NOT re-sort (only `mergeHighlights`
  does), so agent ops applied via `setHighlights` PRESERVE explicit order
  → move/reorder/placement actually work.
- `operations.ts` — pure `Highlight[]` transforms returning
  `TimelineOpResult{highlights, changed, createdClipIds, note}`:
  addClips/appendClips/prependClips/addClipRef/moveClip/removeClip/
  replaceClip/extendClip/trimClip. Inline ids + `import type Highlight`
  (erased) → unit-testable. Exact ranges kept verbatim.

### Phase 4 — `lib/agent/orchestrator.ts`
- `orchestrate()` (async, React-free): observe → reinforcement → parse →
  resolve (source/clip/time/placement/concept) → confidence policy →
  `AgentDecision` = `operations | clarify | reinforcement_only |
  needs_visual | fallthrough`, with `ResolvedOp[]` for the runner.

### Phase 5 — `lib/agent/conceptResolver.ts`
- `resolveConcept()` honest search order: exact range → transcript
  (lexical token overlap on the LOCAL Whisper transcript) → OCR (honest
  unavailable) → visual fallback (`needsVisualAnalysis: true`). Generic
  "best parts" → visual/motion, NO fixed count. `ConceptMatch` carries
  `evidenceType` (range/transcript/ocr/video-memory/vision/motion).

### Phase 6 — `lib/ocr/`
- `types.ts` (`OcrEngine` interface) + `query.ts` (`queryOnScreenText`
  returns `available:false` with an honest status; `registerOcrEngine`
  for a future, capability-gated, lazy, local engine). No heavy dep added
  (deliberate — bundle-size review required first). The agent never
  claims to read on-screen text it can't.

### Phase 7 — reinforcement (`lib/agent/reinforcement.ts`)
- `detectReinforcement()` → patch + reject/like/positive-ref/research
  signals ("not this", "more like clip 2", "use video 1 only", "this is
  perfect", "avoid intro", "more action").
- `adjustScore()` pure: rejected-range overlap penalty, liked boost,
  source preference, concept boost/penalty, motion style nudge.

### Phase 8 — UI feedback
- The client runner pushes ONE assistant message per action carrying the
  confirmation + assumptions ("Using video 2 because…") and an `agent`
  attachment with the evidence label ("transcript match"/"exact range")
  + confidence. No UI redesign.

### Wiring — `lib/agent/runAgentCommand.ts`
- `tryAgentCommand()` builds `AgentCommandContext` + a `getTranscript`
  (source hash → transcript) from the live store, keeps a per-session
  `AgentMemoryStore` (module map), runs `orchestrate`, applies
  `ResolvedOp`s via `lib/timeline/operations` + `store.setHighlights /
  selectClip` (undo preserved). Wired into `app/editor/page.tsx`
  `handleAgent` BEFORE `tryQuickShortcut`: `handled` → return;
  `needsVisual`/`fallthrough` → continue to the unchanged quickMatch +
  cloud planner. Lazy-imported (stays out of the initial bundle).

### Config (`lib/config.ts`)
- `AGENT_POLICY` (execute 0.85 / note 0.65) + `AGENT_GUARDRAILS`
  (maxAgentClipSeconds 600, minAgentClipSeconds 0.3, defaultExtendSeconds
  2, maxConceptMatchesPerTurn 8). Documented as SAFETY guardrails, not
  hidden editing decisions — no fixed output clip count or forced length.

## Tests
- `scripts/ts-ext-hook.mjs` + `register-ts-ext.mjs` — a `node --test`
  resolver hook that appends `.ts` to extensionless relative imports (the
  existing tests were import-free to dodge this; the hook lets the new
  tests import real source modules). Loaded via `--import` in the test
  scripts only — never in the app build.
- New: `timeRangeParser`, `sourceResolver`, `clipResolver`,
  `editCommandParser`, `agent-memory/policy`, `timeline/operations`.
- `npm test` = **86 pass / 0 fail** (36 existing + 50 new).
- `npm run typecheck` ✓, `npm run build` ✓ (`/editor` first-load JS
  168 kB; agent layer is a lazy chunk).

## Honesty / privacy
- No video bytes leave the browser; agent layer is fully client-side.
- No provider keys touched; server routes unchanged.
- OCR/vision not faked — OCR reports unavailable; visual concept search
  defers to the existing pipeline (`needs_visual`).

## What remains (not done here)
- The visual concept path returns `needs_visual` and falls through to the
  cloud planner; it does NOT yet build a scenario plan from the resolved
  source + reinforcement and auto-run `executeForSource` directly. A
  future enhancement could route `needs_visual` straight into the in-
  browser pipeline with reinforcement-adjusted scoring (the pieces —
  resolved source ids, concept, `adjustScore` — are ready).
- Agent memory is in-memory per tab session; `serialize/hydrate` exist
  but IndexedDB persistence (via `lib/store/idb.ts`) is not wired yet.
- Cross-source `move`/`reorder` is honoured via `setHighlights`, but a
  later auto plan/merge run still re-groups by source (mergeHighlights
  sort) — the orchestrator surfaces a note rather than failing silently.
- **Browser runtime verification is REQUIRED** — see TODO. The sandbox
  has no WebGPU/transcript data, so the end-to-end command→clip behaviour
  (esp. transcript-grounded concept search) was not exercised live.

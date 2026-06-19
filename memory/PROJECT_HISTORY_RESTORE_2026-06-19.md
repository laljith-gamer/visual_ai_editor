# Project history restore (2026-06-19)

> Full project/session restore. The app now remembers the WHOLE editing
> project (chat + sources + timeline + plan + transitions + UI state) and can
> reconnect previous uploads by HASH when the same file is re-uploaded — so a
> reloaded project arranges itself exactly as before. Local-first, IndexedDB,
> **no video blobs persisted by default.**

## Problem it fixes

History used to restore chat/session metadata but WIPE the runtime sources
(blobs/object URLs can't survive a reload). The remembered timeline was
disconnected from real files, and re-uploading the same video made a NEW
source id — orphaning the old clips.

## Core model

We never store blobs. Each project persists a `PersistedSourceManifest[]`
(`id`, `hash`, `meta`, `addedAt`, `lastKnownName`, `status`). On restore the
sources become `RestoredSourcePlaceholder`s (`missing: true`, NO blob/url) that
keep the SAME ids, so timeline clips still reference them. A re-upload is
matched by **hash only** (filenames are a weak hint) and reconnected to the
original id.

Pipeline: `user re-uploads file → probe + hash → resolveUploadIdentity →
hydrate existing id (reconnect) OR addSource (new) → timeline renderable`.

## Pure logic — `lib/store/projectRestore.ts` (unit-tested)

| Helper | Purpose |
|--------|---------|
| `migrateSessionToManifests` | v1 (`videoMeta`/`videoHash`) / v1.6 (`sources[]`) / v2 (`sourceManifests`) → manifests. Backward compatible. |
| `backfillHighlightSources` | Legacy untagged highlights → the single source id (so they reconnect). |
| `buildRestoredProjectState` | manifests → missing placeholders + active/selected ids + preserved highlights. Never allocates a URL. |
| `resolveUploadIdentity` | Hash match → `{kind:"hydrate"}` (same id) else `{kind:"new"}`. |
| `usedMissingSources` / `canRenderTimeline` | Render guard: which used sources are missing; is the timeline renderable now. |
| `buildPersistManifests` | Combine hydrated ("available") + missing manifests so a partial-restore re-save loses nothing. |
| `summarizeSession` | History summary (sources / missing / clips / duration / format / status / last action). |

## Store (`hooks/useEditorStore.ts`)

- New state `missingSources: RestoredSourcePlaceholder[]`.
- `hydrateRestoredSource(blob, meta, hash)` — hash match → reconnect the
  original id (attach blob+url, drop placeholder, restore active/selected);
  else `addSource`. The ONLY place a placeholder turns into a runtime source.
- `usedMissingSources()`, `canRenderCurrentTimeline()` selectors.
- `restoreSession` rebuilt on the pure helper (placeholders, not a wipe).
- `persist` writes the full manifest + `selectedClipId` / `boundaryTransitions`
  / `pendingTimelineOp` / `pendingExecution` / `inferred` / `userTier` /
  `lastBriefing` at `schemaVersion: 2` (legacy `sources` summary still written).
- `removeSource` also removes a missing placeholder on EXPLICIT delete (restore
  never calls it); `setActiveSource` accepts a missing id (blank preview).

## UI

- **ProjectRail:** missing banner ("This project needs N missing videos"),
  placeholder cards (name/duration/aspect + "Missing — re-upload to restore" +
  Re-upload), "Restored previous video: …" toast on hash match, richer history.
- **Timeline:** missing clips marked "⚠ source missing", dashed, not
  draggable; missing sources still appear as tabs.
- **Render guard** (`handleRender`): honest "Re-upload the missing source video
  before rendering" — ffmpeg/mediabunny never gets a missing input.
- **Upload paths** (ProjectRail + `/launch`) both route through
  `hydrateRestoredSource`.

## Constraints honored

- No blobs persisted by default; hash (not filename) is identity; a non-matching
  re-upload is a new source (never a silent swap); old sessions still load.

## Validation

`npm run typecheck` ✓, `npm run build` ✓ (/editor 176 kB), `npm test` =
**243 pass / 0 fail** (+18 restore tests). Browser re-upload + render still
needs a real browser.

## NOT done (honest scope)

Phase 4: opt-in blob persistence (+ quota warning), File System Access handle
restore, and rendered-output history. Deferred by design.

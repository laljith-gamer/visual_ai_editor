# 2026-06-19 — PR 57: production tool reliability (export/download + render-vs-export split)

> From issue #57's PR sequence. Scope kept tight: make the basic editor
> reliable without AI/WebGPU/backend. The biggest concrete gap was the
> EXPORT/download path; the rest (direct commands, undo/redo, render
> wiring) already landed in the 2026-06-18 offline fast-editor pass and
> was verified, not rewritten.

## What changed

### Reliable export/download (the real gap)
Before: the Export button used a hardcoded `shorts-studio.mp4` filename,
was hidden entirely when there was no rendered blob (no "Render first"
state), and had no fallback when a browser blocked the save.

- New `lib/util/download.ts`:
  - PURE, tested: `safeTitleSegment`, `exportTimestamp` (`yyyyMMdd-HHmmss`),
    `buildExportFilename` → `shorts-studio-{safe-title}-{yyyyMMdd-HHmmss}.mp4`.
  - BROWSER `shareOrDownload(...)` → tries Web Share, falls back to an
    anchor download, and reports `{shared,downloaded,blocked,cancelled}`
    so callers can show fallback guidance (never silent).
- `hooks/useShare.ts` refactored to a thin wrapper over `shareOrDownload`
  (one tested code path for share + export). API stable.
- New `hooks/useExport.ts` → reads `renderedBlob` + session title, builds
  the deterministic filename, shares/downloads, and returns a message:
  no blob → "Render first"; blocked → fallback guidance; success →
  "Saved <filename>".
- `components/PreviewToolbar.tsx` → Export button is ALWAYS visible
  (clicking with no render shows "Render first"), shows a transient status
  message, and disables while exporting. Export never silently does
  nothing.

### Render vs Export split in the fast command router
- `lib/intent/fastCommands.ts`: `export`/`download`/`save the video` now
  classify as a NEW `export` kind (previously folded into `render`).
  `render`/`assemble`/`finish` stay `render`. Added a PURE, exhaustive
  `decideFastAction(kind, state)` → `delegate | nudge_affirm | nudge_cancel
  | undo | redo | render | render_empty | export | export_no_render`
  (makes the routing decisions unit-testable without the store).
- `lib/agent/runAgentCommand.ts`: `handleFastCommand` now uses
  `decideFastAction` and is async; chat `export` calls a new `deps.onExport`
  (wired to `useExport`) and shows its message; `export` with no render →
  "render first". Render still uses `deps.onRender` (real `handleRender`).
- `app/editor/page.tsx`: added `useExport` + `handleExportRef` and passes
  `onExport` into `tryAgentCommand` (mirrors the existing `onRender` ref).

## Verified (code-level, not browser)
- Render button (`onRender=handleRender` via EditorStage) and chat "render"
  (`onRender` ref → `handleRender`) use the SAME core path.
- Export button (`useExport`) and chat "export" (`onExport` ref →
  `useExport`) use the SAME core path.
- ClipsDrawer: closable (close button + scrim `onClose`, unmounts on
  `!open` — no hidden overlay), Remove uses `removeHighlight` (snapshots →
  undoable), empty state "No clips yet.".
- Timeline remove/move/trim go through the store's snapshotting actions →
  one-step undo + redo (from 2026-06-18). No store changes this PR.

## Tests (+? → 112 pass / 0 fail)
- Updated `lib/intent/fastCommands.test.ts`: `export`/`download` classify as
  `export` (not `render`); render stays render; "render the part where he
  scores" / "export the funny bit" → null; new `decideFastAction` tests
  cover undo/redo→store, render vs render_empty, export vs
  export_no_render, affirm/cancel delegate-vs-nudge.
- New `lib/util/download.test.ts`: safe filename slug/fallback/length +
  `yyyyMMdd-HHmmss` timestamp + deterministic filename.

## NOT done (honest)
- Browser/manual verification (upload MP4/MOV/WebM, preview, real download,
  blocked-download guidance) — needs a real browser; not possible in the
  sandbox. See the manual checklist in the PR / TODO.
- No changes to upload flow or preview internals (inspected; no clear bug
  to fix without browser repro — left working logic untouched per the
  constraints).
- Did NOT auto-render on chat "export" (honest "render first" instead).

## Validation
`npm run typecheck` ✓ · `npm run build` ✓ (`/editor` 169 kB first load) ·
`npm test` = 112 pass / 0 fail.

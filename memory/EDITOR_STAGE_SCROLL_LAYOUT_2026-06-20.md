# Editor stage preview/timeline scroll layout fix — 2026-06-20

## User-reported problem

The editor preview area was visually squeezed/cut by the lower timeline area. In the screenshot, the preview video panes did not have enough reserved height, and the timeline/inspector section consumed the lower stage space instead of scrolling independently.

## Change made

- `components/EditorStage.tsx`
  - Added explicit CSS-module hooks for the preview card/body and timeline card/body.
  - Kept existing preview, timeline, render, and inspector behavior unchanged.

- `components/EditorStage.module.css`
  - Changed the editor stage from a single vertical scroll surface to a fixed two-row grid:
    - preview row: flexible `minmax(0, 1fr)`
    - timeline row: capped `auto` row
  - Made the preview body scroll independently when vertical space is tight.
  - Made the timeline body scroll independently with a capped height (`max-height: min(44dvh, 390px)`, smaller on short screens).
  - Increased preview video minimum height for desktop/tablet editor layouts.
  - Preserved `object-fit: contain` so videos are not internally cropped.
  - Added mobile fallback so narrow screens keep the normal page flow instead of nested fixed-height scrolling.

## Expected result

- The timeline no longer pushes over or visually cuts the preview panes.
- The preview remains usable on shorter screens because its body can scroll.
- The timeline/transition/inspector controls remain accessible through their own scroll area.
- Mobile/narrow layouts remain simple and page-scroll based.

## Validation status

- Code was updated in GitHub on branch `fix/editor-stage-scroll-layout`.
- Manual browser verification is still required: upload a source, create clips, confirm the two preview panes are fully visible, then scroll the timeline/inspector area independently.
- Typecheck/build were not run in this connector-only edit session.

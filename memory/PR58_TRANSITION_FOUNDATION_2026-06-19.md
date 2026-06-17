# 2026-06-19 — PR 58: per-boundary transition foundation (small, low-risk)

> Issue #57 PR 58. Kept deliberately SMALL: types + honest mapping +
> tests only. NO render-worker or UI changes (those are the larger
> follow-up). Stacked on top of PR 57.

## What changed
- `lib/config.ts` `TRANSITIONS` — centralized, documented duration
  guardrails (`defaultDurationSeconds` 0.4, `maxDurationSeconds` 1.0).
- `lib/transitions/types.ts`:
  - `TransitionType` = cut | fade | crossfade | dip_to_black | slide |
    zoom | glitch | whip | match_cut.
  - `RenderableTransition` = none | fade | crossfade (what the ffmpeg
    worker actually applies today).
  - `BoundaryTransition { index, type, durationSeconds? }` — the
    per-boundary model (boundary i = between clip i-1 and clip i).
  - `isRenderImplemented`, `normalizeTransitionDuration` (default+clamp),
    `withTransitionDefaults`.
- `lib/transitions/map.ts`:
  - `mapTransition(type)` → `{ intended, render, label, exact, note? }`.
    cut/fade/crossfade are EXACT; dip_to_black→fade, slide/zoom/glitch/
    whip→crossfade, match_cut→cut are flagged `exact:false` with an honest
    `note` ("Zoom isn't rendered yet — using a crossfade").
  - `toRenderable(type)` and `describeMappedDowns(types[])` (one honest
    sentence for any mapped-down transitions, "" when all exact).
- `lib/transitions/map.test.ts` — 7 tests: exact mappings, down-maps +
  notes, glitch/whip/match_cut never claimed rendered, `toRenderable`
  only emits worker-supported values, duration default/clamp,
  `describeMappedDowns`.

## Honesty
glitch / whip / match_cut (and dip_to_black / slide / zoom) are NOT
claimed as rendered — `exact:false` + a note explaining the down-map.
This mirrors the existing compose transition honesty
(`lib/plan/composeTransition.ts`), now generalized to a per-boundary model.

## NOT done (intentional — larger follow-up)
- Render worker still applies a single transition; it does NOT yet consume
  `BoundaryTransition[]` per boundary.
- No transition picker UI between clips.
- No chat commands ("add fade between clip 1 and 2", "make transition
  cut") wired to the model yet.
- `dip_to_black` / `slide` / `zoom` are not actually rendered (mapped down
  honestly until implemented).

## Validation
`npm run typecheck` ✓ · `npm run build` ✓ · `npm test` = 119 pass / 0 fail.

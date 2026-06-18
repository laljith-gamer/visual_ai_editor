# Issue #64 — professional video-prompt interpreter (compose no longer fabricates topics)

**Date:** 2026-06-19
**Issue:** #64 (labels: bug, production, offline)
**Status:** fixed in code; validated by typecheck/build/unit tests. Browser run
NOT performed here (no GPU/video decode in sandbox — see checklist).

---

## What was wrong

User: `atleast sect 5 clip from all and make it as combined 5 min video vertical`
App: `Got it — I'll build AI Combined 1 with **atleast sect all** from the first
video, **min vertical** from the second video, and a dynamic transition.`

`deriveComposeIntent` Tier B split the prompt into two clauses and `extractTopicTokens`
kept meta/editing words (`atleast`, `sect`, `all`, `min`, `vertical`) as if they
were content topics, mapping the garbage onto source 0 / source 1. Duration
(`5 min`), format (`vertical`), clip count (`5 clip`), and source scope (`all`)
were all ignored.

## What was built

A reusable, professional **prompt-understanding layer** that extracts structured
slots BEFORE the specialized detectors assign meaning.

### New module: `lib/intent/videoPromptInterpreter.ts` (pure, tested)
- `normalizeVideoPromptText` — spelling/spacing cleanup only (atleast→at least,
  sect→select in clip context, 5min→5 min). Reports evidence. Never expands
  meaning (no min→minutes, which would clash with "min 5 clips" = minimum).
- `parseDuration` — "5 min"→300, "40 sec"→40, "1:30"→90, words, clamped.
- `parseClipCount` — "at least 5 clips"→min 5, "5+"→min, "max 5"→max,
  "around 5"→target, plain "5 clips"→target. Guards: "5 min" is NOT a count,
  "clip 5" (noun then number) is a timeline INDEX, left to the edit parser.
- `parseFormat` / `parsePlatform` — vertical/horizontal/square; tiktok/reels/
  shorts → vertical.
- `parseSourceScope` — "from all videos" / "every upload" → `all`.
- `META_VOCAB` + `isMeaningfulContentTopic` + `extractMeaningfulTopic` — the
  core guard: a token set made of only meta/editing/output/number words yields
  NO topic. This is grammar cleanup, NOT a genre table.
- `splitExclusions` — "…but avoid intro" → exclusions ["intro"], keeps the rest.
- Thresholds live in `lib/config.ts → VIDEO_PROMPT` (duration/clip bounds,
  maxComposeSources).

### `lib/plan/composeIntent.ts` refactor
- Normalizes once, parses the slots, and builds topics ONLY from
  `extractMeaningfulTopic` — meta words can never become a per-source query.
- Tier A (per-source semantic compose) preserved; now also carries
  duration/format if stated.
- NEW all-sources compose: explicit all-videos scope + any build/combine cue or
  output constraint → a generic (or single-topic) compose with
  `sourceScope:"all"`, `targetSeconds`, `format`, `minClipCount`,
  `genericBestParts`/`allSourcesTopic`, `sources:[]`. Clean message, no fake
  first/second assignments.

### Type + execution wiring
- `MultiSourceComposePlan` extended: `sourceScope`, `format`, `minClipCount`,
  `genericBestParts`, `allSourcesTopic`.
- `lib/plan/composeNormalize.ts` reads the new fields (optional LLM path) and
  allows empty `sources` when `sourceScope:"all"`.
- `lib/plan/prompt.ts` documents the all-source compose fields for the LLM.
- `app/editor/page.tsx` compose execution: for `sourceScope:"all"` it fans out
  across EVERY eligible upload (capped at `VIDEO_PROMPT.maxComposeSources`),
  splits the target duration evenly, uses the shared topic or broad
  visual-interest selection (issue #62 offline fallback handles underfill).
  Honest reporting: warns when it can't reach `minClipCount` or the target
  duration. Honors `format`/duration at render via `buildComposeOutputPlan`.

## Files changed
- `lib/intent/videoPromptInterpreter.ts` (new) + `.test.ts` (new)
- `lib/plan/composeIntent.ts` (refactor)
- `lib/plan/compose.test.ts` (+#64 cases)
- `lib/plan/composeNormalize.ts` (new fields, empty-sources for all-scope)
- `lib/plan/composeSubPlan.ts` (`buildComposeOutputPlan`)
- `lib/plan/prompt.ts` (all-source compose docs)
- `lib/types.ts` (`MultiSourceComposePlan` fields)
- `app/editor/page.tsx` (all-source execution + honest reporting + format)
- `lib/config.ts` (`VIDEO_PROMPT`)
- `package.json` (test:compose uses the ts-ext hook; new test registered)

## How generic all-source compose works
1. `deriveComposeIntent` flags `sourceScope:"all"`, parses target/format/minClips,
   decides generic vs shared-topic.
2. The client expands to all eligible uploads, each gets a sub-plan
   (visual-interest when generic, semantic when a topic), budgeted to
   target ÷ N seconds.
3. Per-source runs go through the REAL `executeForSource` pipeline; the issue
   #62 offline best-parts fallback fills short/weak sources.
4. Clips are ordered + transitioned, the timeline is replaced (undoable), and
   the summary honestly notes any clip-count / duration shortfall.

## Assumptions surfaced to the user
- "I'll use all currently loaded videos" (implicit in the all-source message).
- Underfill: "you asked for at least N clips but I only found M…"; "it runs Xs
  of your Ys target — want me to broaden?".

## What remains / not supported
- All-source compose still needs ≥2 uploads (a 1-video "combine all" asks for a
  second rather than degrading to single-source best-parts).
- `splitExclusions` records exclusions and shows them in the message but does
  not yet feed an `avoid` list into the per-source sub-plans (the pipeline's
  avoid handling is minimal). Noted in TODO.
- `classifyVideoPromptIntent` (full control/question/exact_edit routing schema
  from the brief) was scoped down: the interpreter ships the slot extractors +
  meaning guard that the bug needed; the existing fast-command / edit / question
  detectors keep their routing. A future pass can unify routing on the
  interpreter.

## Validation
- `npm install` ✓ (already present this session)
- `npm run typecheck` ✓
- `npm run build` ✓ (only the pre-existing `@huggingface/transformers` warning)
- `npm test` ✓ — 198 tests pass (was 172; +13 interpreter, +13 compose #64).

## Manual browser checklist
- [ ] Upload 2–3 videos.
- [ ] Ask `atleast sect 5 clip from all and make it as combined 5 min video vertical`:
      clean message, no "atleast sect all" / "min vertical", no fake first/second,
      source scope all, target 5 min, vertical, ≥5 clips if possible.
- [ ] `pick combat in first video and cutscene in second and make transition` —
      per-source compose still works.
- [ ] `make a 40 sec reel of cooking shots` — single-source topic path unchanged.
- [ ] `remove clip 5` — still a direct edit (not clip count).
- [ ] `select 5 clips from all videos` — clip count, not index.
- [ ] Render/export the combined timeline; verify vertical output.
- [ ] Underfilled target explains honestly; no cloud/WebGPU required.

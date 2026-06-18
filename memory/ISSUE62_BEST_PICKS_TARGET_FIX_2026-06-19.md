# Issue #62 — "best picks for reels for 40 sec" produced a 1s "ready" clip

**Date:** 2026-06-19
**Issue:** #62 (labels: bug, production, offline)
**Status:** fixed in code; validated by typecheck/build/unit tests. Browser
verification NOT performed here (no WebGPU/video in sandbox — see checklist).

---

## What was wrong

Live UI: user asked `make a best picks for reels for 40 sec`. The app replied
"I'll look for **best and picks** moments and build a 40s short", then produced
**one 1.0s clip** (~17:51→17:52, top score 0.35, "Vision verdict unavailable;
defaulted to neutral") and marked it **ready to render**.

Three independent defects combined (all on the deterministic / offline path,
which is the DEFAULT since `cloudAiDisabled()` returns true unless
`DISABLE_CLOUD_AI=false`):

1. **Intent parsing.** `deriveActionableIntent` treated the generic words
   `best` and `picks` as literal search subjects → scenarios "best moments" +
   "picks moments" → SigLIP scored meaningless prompts → weak ~0.3 scores.
2. **Underfill.** With no window surviving the `minClipSeconds` filter, the
   budgeted path fell to `forceMinFallback`, which returned a single
   un-expanded 1.0s candidate. No attempt to expand/spread toward the 40s ask.
3. **Dishonest status.** The orchestrator unconditionally said "Picked 1 clip
   totalling 1.0s … Tap Render" and set status `ready` — even though the
   result covered 2.5% of the requested duration with low confidence.

## What was fixed

1. **Generic best-parts intent** (`lib/plan/deriveIntent.ts`)
   - New `GENERIC_EDIT_VOCAB` set (best, picks, top, key, highlights, montage,
     recap, …) + `REEL_OUTPUT_RE` (reel/short/montage/…). These are generic
     EDITING/OUTPUT words, NOT a genre/subject table.
   - Subject tokens = core tokens minus generic vocab. When nothing concrete
     remains AND (a generic word OR duration+reel context) is present, the
     request is flagged `genericBestParts: true` (new `ActionableIntent`
     field) with focus `best moments`, rawFocus `visual interest`,
     scenarioLabels `["visually rich moments"]`. Duration is preserved.
   - A concrete subject next to "best" (e.g. "best cooking moments") stays
     subject-driven. "make a short" (no duration, no best word) stays
     non-actionable (UX unchanged).
2. **Offline visual-interest scoring** (`app/api/agent/route.ts`)
   - `synthesizeVaguePlan` now uses `SIGNAL_DEFAULTS.visualInterest`
     (semantic = 0 → SigLIP skipped; motion + saliency drive selection) for
     generic best-parts asks. No WebGPU, no cloud.
3. **CPU/offline best-parts fallback** (`lib/pipeline/bestParts.ts`, pure)
   - `expandClipRange` grows short/1s peaks to a useful minimum, clamped to
     the source, shrinking to avoid overlapping already-chosen clips.
   - `buildOfflineBestParts` buckets the source for spread, picks best per
     bucket, tops up by score, expands + de-overlaps, approaches the target.
     NO fixed clip count (emerges from target / source / spread / config).
   - Wired into `lib/pipeline/highlights.ts`: when `userSpecifiedDuration` and
     the strong-match selection is empty or below
     `TARGET_COVERAGE.minReadyFraction`, the fallback replaces it when it
     covers more (marked `weakOnly`). Also runs in the `scored.length === 0`
     early-return path (the exact bug path).
4. **Honest coverage + status** (`lib/pipeline/coverage.ts`, pure; wired in
   `app/editor/page.tsx`)
   - `assessTargetCoverage` returns `review` for a hard underfill (< 25% of
     target) or a weak-confidence underfill (weak AND < 50%). On `review` the
     editor pushes an honest message (states found vs target seconds, offers a
     broader reel), sets the new `needs_review` status, and does NOT say "Tap
     Render" / "ready to render". Render stays available (user agency).
   - No explicit duration → always `ok` (quality-floor path unchanged).
5. **Central config** (`lib/config.ts`)
   - `TARGET_COVERAGE` (minReadyFraction 0.6, hardUnderfillFraction 0.25,
     weakConfidenceAskFraction 0.5, minUsefulClipSeconds 3) and
     `OFFLINE_BEST_PARTS` (preferredClipSeconds 8, fillToFraction 1.0,
     maxClips 12), all commented. No thresholds hard-coded in pipeline code.
6. **New status** `needs_review` added to `JobStatus` and labelled in
   `components/Topbar.tsx` + `components/ProjectRail.tsx`.

## Files changed

- `lib/plan/deriveIntent.ts` — generic best-parts parsing + new field.
- `lib/plan/deriveIntent.test.ts` — generic best-parts tests.
- `app/api/agent/route.ts` — visual-interest signals for generic best-parts.
- `lib/config.ts` — `TARGET_COVERAGE`, `OFFLINE_BEST_PARTS`.
- `lib/pipeline/bestParts.ts` (new) + `bestParts.test.ts` (new).
- `lib/pipeline/coverage.ts` (new) + `coverage.test.ts` (new).
- `lib/pipeline/highlights.ts` — offline-fallback underfill guard.
- `app/editor/page.tsx` — coverage assessment + needs_review handling.
- `lib/types.ts` — `needs_review` JobStatus.
- `components/Topbar.tsx`, `components/ProjectRail.tsx` — status label/class.
- `package.json` — register new test files.

## What remains / follow-ups

- A latent bug in `lib/pipeline/events.ts`: single-frame windows are sized by
  `plan.sampleEverySeconds` (1.0s) even when adaptive sampling spreads frames
  ~5s apart, so candidate windows can be too short. The offline expansion now
  masks this for explicit-duration asks, but the window sizing itself was left
  unchanged (out of scope, avoid touching unrelated logic).
- A "make the broader reel" one-tap affirm could re-run with a forced-weak
  fallback flag; today the user re-asks or gives a focus. Coverage already
  produces the offer text.

## Validation

- `npm install` ✓
- `npm run typecheck` ✓ (clean)
- `npm run build` ✓ (only the pre-existing `@huggingface/transformers`
  import.meta warning)
- `npm test` ✓ — 172 tests pass (added 6 deriveIntent, 7 bestParts, 6
  coverage cases).
- Browser run NOT performed (no GPU/video in sandbox).

## Manual browser checklist

- [ ] Upload the same/any long video.
- [ ] Ask: `make a best picks for reels for 40 sec`.
- [ ] Chat does NOT say "best and picks moments".
- [ ] Target duration is 40s.
- [ ] Output is NOT a single 1s clip.
- [ ] If confidence is low, the UI explains it (and status is "needs review",
      not "ready to render", when badly underfilled).
- [ ] Render is not pushed as ready when badly underfilled.
- [ ] Transitions appear only when 2+ clips exist.
- [ ] No cloud/WebGPU required for the CPU fallback.

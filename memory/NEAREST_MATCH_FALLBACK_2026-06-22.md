# Nearest-match graceful fallback for the constraint hard gate (2026-06-22)

## The reported bug

Live UI: user uploaded a video and asked **"pick best parts from this duration
2 min of fighting alone attack combo scene"**. The app planned correctly
("I'll look for fighting attack combo-only moments and build a 120s short …
keep only … skip unrelated scenes") and then produced:

> Nothing across the selected video matched strongly enough (top score 0.00).
> Try broader scenarios, or describe a single moment ("find the part where ___").

The user wanted the run to return the **nearest / best-available** footage
instead of dead-ending — explicitly "no hardcode and make mostly near".

## Root cause (precise)

The words "alone / only / keep only" compile the request into a **HARD include
constraint** (`exclusiveOnly: true` → `buildConstraintGraph`), so the
constraint hard gate (`lib/constraints/filter.ts`) runs before window
detection. The gate has three cases for a measurable hard include:

1. `maxInclude === 0` — no signal anywhere → already degraded to a
   motion/saliency **pass-through**, flagged `unmeasurable` (pre-existing).
2. `0 < maxInclude < includeNoiseFloor (0.15)` — the model DID find frames
   closest to the concept, but the strongest still sits below the absolute
   noise floor. `baseCut = max(0.15, maxInclude * 0.55) = 0.15 > maxInclude`,
   so `survivorsAt(baseCut)` drops **every** frame, and coverage relaxation
   floors at `includeNoiseFloor` → still empty. `executeForSource` then returns
   `scoreMax: 0`, and `app/editor/page.tsx` shows "top score 0.00". **← the
   bug.**
3. `maxInclude >= 0.15` — the top frames survive; worked fine already.

CLIP/SigLIP zero-shot similarity for an abstract, compound action phrase
("fighting attack combo scene") routinely lands in this faint band, especially
on stylized game/anime footage and with coarse sampling — so case (2) was easy
to hit.

## The fix (no hardcode, honest)

Added a **nearest-match graceful fallback** to `applyConstraintFilter`,
triggered ONLY when a hard include would otherwise empty the gate while a
measurable signal exists: `enforceInclude && kept.length === 0 && maxInclude > 0`.

In that case keep the frames the model judged **closest** to the concept —
ranked by include match, still **exclude-gated** — instead of returning nothing:

- **Count admitted:** with a stated duration, cover ~the target
  (`ceil(target * coverageTargetFraction / sampleEverySeconds)`); otherwise keep
  the cluster standing out relative to the best near-match
  (`inc >= maxInclude * includeRelativeFraction`).
- Uses **only** the per-frame SigLIP include scores already computed — no
  keyword / genre logic, no new config constants, no faked frame data.
- **Never widens** to off-constraint footage: zero-signal frames (`inc === 0`)
  and exclude-dominated frames are still rejected. If excludes alone empty the
  set, the result is still honestly empty.
- Flags `report.approximate = true` so the rest of the app stays honest: these
  are the *nearest*, not *confirmed*, matches.

### Threading + honesty

- `ConstraintFilterReport.approximate?: boolean` (`lib/constraints/types.ts`).
- `executeForSource` reads it (`constraintApproximate`), logs an explicit
  "kept the N NEAREST-matching frames (approximate)" activity line, returns a
  new `approximate` field, and marks the run `weakOnly: buildResult.weakOnly ||
  constraintApproximate` so it surfaces as **needs_review** (low confidence)
  rather than a confident "ready" — the user can still "render anyway".
- `app/editor/page.tsx` adds a chat note when `aggregate.some(r => r.approximate)`:
  *"I couldn't find an exact match for "X", so these are the closest moments I
  could find. A more visual description (colours, who's doing what, the setting)
  usually tightens the match."* (Distinct from the existing `unmeasurable`
  motion-only note.)

This deliberately changes the old "honest empty / no widening" behavior for the
faint-but-measurable case: returning the nearest on-concept footage is what the
user asked for, and it is still honest (labeled approximate, marked weak). The
truly-empty paths that remain are: all frames excluded, or no frames at all.

## Files changed

- `lib/constraints/types.ts` — `approximate?: boolean` on the report.
- `lib/constraints/filter.ts` — nearest-match fallback + header doc.
- `lib/pipeline/executePerSource.ts` — `constraintApproximate`, log branch,
  `approximate` result field, `weakOnly` OR.
- `app/editor/page.tsx` — honest "closest moments" chat note.
- `lib/constraints/filter.test.ts` — rewrote the old "returns empty (no
  widening)" test to assert the new approximate behavior; added 5 tests
  (nearest kept / duration coverage / respects excludes / zero-signal stays
  unmeasurable / strong match never approximate).

## Validation

- `npm run test:constraints` → **30 pass** (17 filter incl. new, 13 graph).
- `npm test` → **558 pass / 0 fail** (was 522).
- `npm run typecheck` ✓ · `npm run build` ✓ (`/editor` 211 kB).
- **Still needs a real browser + WebGPU** to confirm end-to-end on actual
  SigLIP scores: upload a fight video, ask "fighting attack combo alone 2 min",
  and confirm it now returns the nearest clips with the approximate note +
  needs_review, instead of "top score 0.00". The sandbox has no GPU/decode.

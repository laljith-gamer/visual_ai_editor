# Dynamic free-text chat routing (2026-06-20)

> Fixes a real regression where the chat acted chip-only: "Describe what's in
> this video" triggered "What should I do with it?", natural replies like
> "he is a traveller pick best visits" / "best places here" / "one continuos"
> all looped on "What should I make?" instead of progressing the edit brief.
> The fix adds a pending-question answer resolver, improves intent inference,
> and fixes describe misrouting — all deterministic, no LLM required for the
> core fix (LLM fallback is a documented future step for genuinely ambiguous
> turns).

## Root causes

1. **Describe misrouted as scope_resolution** — `refinementIntent.ts`
   `detectRefinement` matched "this video" in "Describe what's in this video"
   as `scope_only`, which `editorTurnIntent` turned into `scope_resolution`
   before the describe guard could fire. The fix: bail from `detectRefinement`
   early when the text is clearly a describe/visual question.

2. **"What should I make?" loop** — the agentic-intake `runIntake` re-infers
   the brief from scratch each turn without knowing the user is ANSWERING a
   pending question. So free-text like "one continuous" was treated as a brand
   new (underspecified) request → same missing field → same question. The fix:
   a pending-answer resolver that intercepts the turn BEFORE `runIntake` when
   a `pendingClarify` exists.

3. **"best visits" not detected as highlight** — `inferBrief`'s `HIGHLIGHT_RE`
   only matched `best[\s-]?(parts|moments|bits|picks)`, missing "best visits",
   "best places", "pick best X". The fix: expand the regex to `best[\s-]?\w+`
   and add a `pick (?:the )?best` branch.

## New module: `lib/agentic-intake/pendingAnswerResolver.ts`

A pure, unit-tested resolver that interprets free-text replies against a
pending `ClarifyQuestion`:

1. **Exact chip match** (case-insensitive).
2. **Fuzzy/synonym match** (word overlap, containment).
3. **Contextual inference** — even when the user doesn't name a chip, their
   text can resolve the field semantically (output-type synonym patterns +
   content-topic extraction). E.g. "travel vlog best places" → outputType
   `multi_clip` (highlight_reel) + contentFocus "travel, places".
4. Returns null when nothing resolves (caller falls through normally).

The answer resolver uses the existing `normalizeEditingText` for typo
correction ("continuos" → "continuous") so answers work even with typos.

## Wiring

`app/editor/page.tsx` `handleAgent` now has a **pending-question answer
resolution** step between the editor-turn router and the agentic-intake:
- When `pendingClarify` exists, call `resolvePendingAnswer`.
- If resolved (confidence ≥ 0.6), clear the pending clarify and re-run
  `runIntake` so the brief MERGES the new info and decides: proceed (enough
  info) or ask the NEXT question (not the same one).
- If the re-run intake proceeds, the compiled prompt goes to the planner.
- If it asks the next question, that question is asked (loop avoided).

## Other fixes

- `lib/intent/refinementIntent.ts` — describe/visual-question text now bails
  early (returns `none`) so it can't be caught as a scope resolution.
- `lib/agentic-intake/inferBrief.ts` — `HIGHLIGHT_RE` expanded to match
  "best X" generically and "pick best".
- `lib/config.ts` — "continuous" added to the `EDITOR_TURN.editingLexicon`
  so "continuos" is typo-corrected to "continuous".

## Tests

- New `lib/agentic-intake/pendingAnswerResolver.test.ts` (8 tests):
  typo-normalized answers, exact chip, fuzzy chip, contextual inference,
  content-hint extraction, unrelated text rejection.
- Registered in `test:intake` and the main `test` script.
- Full suite: **492 pass / 0 fail**. typecheck ✓, build ✓ (`/editor` 205 kB).

## LLM fallback (documented future step)

The architecture is ready for an LLM text-only fallback at step 4 of the
resolver (when deterministic confidence is below threshold). It would receive
ONLY: user message, previous assistant message, pending question context, clip
count, source count, active target. Never raw video/frames/media. The
deterministic fix is sufficient for the regression cases; the LLM path is for
genuinely opaque turns that the pattern matchers can't resolve.

## Privacy

The pending-answer resolver is PURE (runs client-side, no network). It receives
only text + question context. No video bytes, frames, thumbnails, or transcript
bodies are ever sent anywhere by this module.

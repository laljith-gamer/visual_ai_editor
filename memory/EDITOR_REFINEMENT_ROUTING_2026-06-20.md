# Editor-first turn routing (2026-06-20)

> Fixes a real failing refinement conversation where the app behaved
> planner-first: a vague "find a specific moment" built a 1s short, a 120s
> request that yielded 37s was reported as success, "remove cutscene / only
> fighting" ran a NEW append search (→ "overlap — nothing to add" dead-end),
> "Removed that clip … Want me to go ahead?" was self-contradictory, "yes do
> it" became "look for yes moments", undo claimed "nothing to undo", a
> single-video refine asked for a second video, and "trim to fit" became a
> search. The fix is a GENERIC editor-turn routing layer that runs BEFORE the
> planner. NO hardcoded phrases, NO game/entity/genre tables.

## New pure, unit-tested modules (lib/intent + lib/timeline)

- **`editingNormalize.ts`** — generic editing-vocabulary typo correction via
  Damerau-Levenshtein against a small, extensible `EDITOR_TURN.editingLexicon`
  (control + cross-domain content-structure words). "combact"→"combat",
  "cutsecene"→"cutscene", "comabt"→"combat". Real content subjects (character
  names, brands) are never near a lexicon word → preserved verbatim.
- **`topicPhrases.ts`** — preserves the user's CONTENT phrase GROUPS instead
  of token soup: "red boy and wukong fight best combat scene" →
  `["red boy", "wukong fight", "combat"]` (NOT "red and boy and wukong and
  fight"). Splits only at connectors/punctuation/meta words; reuses
  `META_VOCAB`.
- **`targetDurationMemory.ts`** — "latest explicit duration wins"
  (`resolveActiveTarget`), plus `isTrimToFitPhrase` / `isDurationOnlyInstruction`.
- **`refinementIntent.ts`** — classifies remove / keep-only / filter /
  trim-to-target / scope-only turns and extracts include/exclude CONTENT
  phrases. Defers specific clip-INDEX edits ("remove clip 2") to the existing
  deterministic clip path.
- **`editorTurnIntent.ts`** — the router brain: `classifyEditorTurn(text, ctx)`
  → confirm_pending / cancel_pending / scope_resolution / trim_to_target /
  refine_timeline / clarify_missing_specific_moment / passthrough. Conservative:
  anything it doesn't recognise returns "passthrough" so existing read-only /
  describe / agent-command / intake / planner paths run unchanged.
- **`lib/timeline/trimToTarget.ts`** — pure trim-to-target (drops WHOLE clips,
  "strongest" or "order" strategy, never removes the only clip).

## Wiring (live)

- **`app/editor/page.tsx`** — a `routeEditorTurn` step runs at the top of
  `handleAgent`, AFTER pending-overlap resolution and a "render anyway"
  override, and BEFORE the conversation guard / agent commands / planner. It:
  - confirms/cancels a concrete pending action;
  - applies a confirmed re-pick by re-dispatching a CLEAN replace request
    (`handleAgentRef`, `forceReplace`) — never an append search;
  - trims to the active target (`trimTimelineToTarget`, snapshots undo);
  - asks before any content refine/remove (sets `pendingAction`);
  - asks "which moment?" for a vague specific-moment request;
  - keeps the active target in sync every turn (latest explicit wins).
  - A stray "yes/no" with NOTHING pending is answered honestly (never a
    search); "yes" is NOT hijacked when a planner run/clarify is parked.
- **`hooks/useEditorStore.ts`** — new `pendingAction` (refilter | swap_timeline),
  `activeTargetSeconds`, and `trimTimelineToTarget` (snapshots for undo).
- **`lib/agent/orchestrator.ts`** — the low-confidence clarify no longer emits
  the self-contradictory past-tense "Removed that clip … Want me to go ahead?";
  it asks a real, forward-looking question and never claims a mutation it
  didn't perform (undo guarantee: claimed mutations go through snapshotting
  store actions).
- **`lib/plan/deriveIntent.ts`** — applies editing-typo normalization before
  tokenizing, so search typos ("combact") don't survive as broken subjects.
- **`runPipeline` (page.tsx)** — append overlap no longer dead-ends with
  "nothing to add"; it offers a one-tap REPLACE (`swap_timeline` pending
  action). Target-coverage review now runs on APPEND runs too (a 120s request
  yielding 37s → needs_review, not success). A weak result (low top score) is
  set to `needs_review` with broaden/deeper-scan options, not presented as
  ready. The render guard blocks rendering from `needs_review` unless the user
  says "render anyway".

## Tests
- New `test:editor` script (52 tests): editingNormalize, topicPhrases,
  targetDurationMemory, refinementIntent, editorTurnIntent, trimToTarget, and a
  conversation-derived `editorTurnRouting.regression.test.ts` (generic
  assertions, not exact phrases). All registered in the main `test` script.
- `npm run typecheck` ✓, `npm run build` ✓ (`/editor` 204 kB),
  `npm test` = **484 pass / 0 fail**.

## Honest limits / still needs browser verification
- Content-based refinement ("keep only fighting") re-picks via a clean REPLACE
  search (we lack per-clip captions to filter existing clips semantically); it
  always ASKS first and snapshots undo. Exclusions are best-effort offline.
- The genuine new-search SigLIP scenario splitting in `deriveIntent` is
  unchanged (intentional per-subject labels); phrase preservation is delivered
  via `topicPhrases` for the router. The deterministic planner MESSAGE for a
  brand-new multi-subject search can still read as a list.
- Not yet run in a real browser: the end-to-end refine→confirm→replace,
  trim-to-fit, swap-on-overlap, and render-guard flows (no GPU/decode in the
  sandbox).

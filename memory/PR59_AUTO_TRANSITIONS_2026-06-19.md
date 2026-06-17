# 2026-06-19 — PR 59: auto transition picking (offline, evidence-based)

> Production auto-transition engine: the editor chooses a natural
> transition between clips from GENERIC media signals — no genre/keyword
> tables. Fully offline + deterministic; no WebGPU, no cloud. Builds on
> the PR 58 foundation (`lib/transitions/{types,map}`), now on main.

## Strict no-hardcode
There is NO `gaming=glitch` / `cooking=fade` style table anywhere. The
selector reads only: same-source vs different-source, time gap, motion &
saliency level/contrast, transcript & label overlap, scene/chapter
continuity, and explicit user preference. All thresholds live in
`lib/config.ts → TRANSITIONS.autoPick` with comments.

## What was built

### Phase 0 — types extended (backward-compatible)
`lib/transitions/types.ts`: `BoundaryTransition` gained OPTIONAL `mode`
("auto"|"manual"), `confidence`, `reason`, `evidence`, `render`, `exact`,
`note`. `withTransitionDefaults` no longer returns `Required<>` (so the
new optional fields don't break it). PR 58 map tests still pass unchanged.

### Phase 1 — config
`TRANSITIONS.autoPick` { sameSourceAdjacentGapSeconds 1.0, relatedTopicFloor
0.35, highMotionFloor 0.6, lowMotionCeiling 0.25, strongContrastFloor 0.45,
defaultConfidence 0.65 } — documented technical guardrails.

### Phase 2 — features (`lib/transitions/features.ts`)
`buildTransitionFeatures(prev, next, context)` → sameSource/sourceChanged,
timeGap, temporallyAdjacent, motion/saliency + contrasts, transcript &
tag (label) overlap (Jaccard), scene/chapter continuity, user prefs,
evidence[]. All context resolvers optional + guarded — missing
transcript/tree/motion never crashes (degrades to source+gap).

### Phase 3 — selector (`lib/transitions/auto.ts`)
`selectAutoTransition` — fixed, documented precedence: fast-pref→cut,
high-motion→cut, smooth-pref→crossfade/fade, strong-contrast→fade,
low-motion→crossfade, diff-source related→crossfade / unrelated→fade,
same-source adjacent→cut, same-source time-jump→fade, default→cut. Returns
a full `BoundaryTransition` (mode auto) with reason+evidence+confidence and
the honestly-mapped `render`/`exact`/`note`. match_cut is NOT auto-picked
(needs real visual-match detection); available as a manual choice.

### Phase 4 — timeline (`lib/transitions/timeline.ts`)
`buildAutoBoundaryTransitions(highlights, {context, existing})` → one
boundary per adjacent pair (indices 1..N-1); preserves manual overrides
whose boundary still exists; drops orphaned manual overrides; clamps each
duration to ≤40% of the shorter neighbour.

### Phase 5 — store (`hooks/useEditorStore.ts`)
New `boundaryTransitions` state + `setBoundaryTransitions`,
`updateBoundaryTransition`, `resetAutoTransitions`, `recomputeAutoTransitions`
(reads the LOCAL transcript for topic overlap; degrades otherwise). The
editor recomputes on a `timelineSeqKey` effect (clip add/move/remove/replace
or source change) — NOT on every resize drag. Manual overrides survive
recompute.
LIMITATION (documented): boundaryTransitions are not part of the undo/redo
snapshot; after undo/redo the auto transitions recompute from the restored
timeline, and manual overrides on the undone state are not restored.

### Phase 6 — UI (`components/TransitionsBar.tsx`)
A chip row under the timeline (render order: "clip i → i+1"). Each chip is
a dropdown (Auto + all 9 types) showing the auto pick label; "Auto" hands
the boundary back to the selector. When a type maps down it shows
"→ <renderable> (mapped)" — never claims an unsupported effect.

### Phase 7 — chat (`lib/intent/transitionCommands.ts`)
Deterministic parse BEFORE the planner: auto-pick / make-all-X /
add-X-between-clip-A-and-B / remove transitions / faster cuts / smoother.
Wired in `runAgentCommand` (`handleTransitionCommand`) which applies to the
store and replies with a per-boundary summary ("1→2 Cut — same source and
adjacent time").

### Phase 8 — render (`lib/pipeline/renderFilters.ts`)
Extracted the ffmpeg filter-graph into a pure, self-contained, tested
helper. `render.worker.ts` now delegates to it. Added an OPTIONAL
`boundaryRenders` (per-clip renderable, index 0 = lead-in) threaded through
`useFFmpeg` → worker AND the mediabunny (preferred) path. When absent, the
GLOBAL transition behaviour is byte-identical to before (verified by test).
The editor passes `boundaryRenders` derived from `boundaryTransitions`.

## What is still mapped down (honest)
- dip_to_black → fade; slide/zoom/glitch/whip → crossfade; match_cut → cut
  (all flagged `exact:false` + a note; UI + chat say so).
- crossfade currently renders as a per-boundary FADE DIP, not a true xfade
  overlap — same as the pre-existing global behaviour. True overlap
  crossfade (ffmpeg `xfade` / mediabunny blend) is future work.

## Reached: feature branch only
All on branch `feat/auto-transitions` (off `main`). NOT on `main` yet —
open a PR and merge. (Note the prior PR #59 was the *foundation*; this is
the auto-picking layer.)

## Validation
`npm run typecheck` ✓ · `npm run build` ✓ · `npm test` = **155 pass / 0
fail** (+36 new: features 6, auto 9, timeline 5, transitionCommands 8,
renderFilters 8). Browser/manual runtime not run here (sandbox has no
GPU/media decode) — see checklist.

## Manual browser checklist
upload video → add 3 clips → auto transitions appear in the bar → change
one manually → move/remove a clip and confirm transitions update (manual
survives) → "auto pick transitions" in chat lists picks + reasons → render
with cut/fade/crossfade → export → pick zoom/glitch and confirm it says
"mapped" → confirm none of this needs WebGPU/cloud.

## Next recommended PR
True overlap crossfade via ffmpeg `xfade` + mediabunny cross-dissolve
(makes crossfade visually distinct from fade), then real dip_to_black /
slide / zoom so they stop mapping down.

# Multi-video flow fix — "Which video?" loop + create/compose hijack (2026-06-22)

## Symptom (user report, 2-video project)
- "pick best scenes in both video and make a 30 sec shorts combines" →
  replied "Using all 2 videos for the next AI run." and STOPPED (no short built).
- "search best moment here" → "Which video should I use?", then "both" / "all" /
  "both video" / "yes" looped on "Which video should I use?" forever.

## Root causes
1. **Create/compose hijack.** `parseSourceControlCommand` (the Library/source
   tool parser) caught any request mentioning "both"/"all videos" and just
   toggled the selection — even when the user clearly asked to CREATE/COMPOSE a
   short. So the compose request never reached the planner.
2. **Clarify answers eaten.** While a source clarify ("Which video?") was
   pending, a bare "both"/"all" reply was also captured by
   `parseSourceControlCommand` as a selection toggle, so the pending clarify
   never resolved → infinite loop.
3. **Resolver ignored the Library selection.** `resolveSource` inferred a
   source only from `activeSourceId`/`lastUsedSourceId`. When neither was set
   (e.g. after restore), it asked "Which video?" even though the user had
   already selected videos in the Library.

## Fixes (lib/intent/sourceResolver.ts, lib/intent/toolCommands.ts, lib/agent/runAgentCommand.ts)
1. **Create/compose guard** in `parseSourceControlCommand`: after the
   active-switch case, return `null` when the text contains create verbs
   (make/create/build/combine/merge/compose/montage/stitch/render/highlight),
   "<reel|short|montage|clip> of/from", a duration ("30 sec"/"1 min"), or
   "best scenes/moments/parts". The request then falls through to the
   planner/compose path that fans across the selected videos.
2. **Pending-clarify gate** in `runAgentCommand.tryAgentCommand`: skip
   `parseSourceControlCommand` entirely while a clarify is pending, so
   "both"/"all" answers reach the pending-answer resolver / planner.
3. **Rule 2b in `resolveSource`**: when no source is explicitly named and there
   are multiple videos, honor the user's Library selection (selected ids that
   still exist) instead of asking. Selecting all → use all (assumption noted);
   a subset → use the subset. Falls back to active/last-used, then clarify.

## No-hardcode compliance
- The create/compose guard uses generic English create-verb / duration /
  "best moments" grammar — NOT a genre/content/per-command table.
- The selection rule is structural (honor the existing checkbox state), not
  phrase-specific.

## Verification
- `lib/intent/sourceResolver.test.ts` + `lib/intent/toolCommands.test.ts`: +6
  tests (selection honored, subset, precedence over stale active, stale ids
  ignored; create/compose returns null; plain selection still works).
- Full suite: 599 pass (was 593). Typecheck clean (0 errors ex-TS5101).
  `npm run build` OK.

## Related UI note (already fixed earlier — PR #86)
The Library "MISSING" card clipping + "1 of 0 selected for AI" footer were
fixed previously (two-row grid for the missing card; `selectedLoadedCount`
counts only loaded sources). A screenshot still showing them reflects a stale
deploy; a rebuild + hard refresh shows the corrected Library.

Branch: fix/intent-llm-reasoning (commit 07d3a8e).

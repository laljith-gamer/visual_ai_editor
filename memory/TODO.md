# TODO

> Prioritized, actionable task list. Keep it short and current — move done
> items to **Completed** (and reflect notable ones in `CHANGELOG.md`).
> Larger directional items live in `ROADMAP.md`.
>
> Last updated: 2026-06-10

## High priority

- [ ] **Wire the merged local-first chat/tool system into the assistant UI**,
      behind a feature flag defaulting OFF. (`lib/llm/` + `lib/vision-core/`
      are on main; UI integration + tool-decision execution is missing.)
- [ ] Merge the remaining open PRs: #28 (temporal fix), #29 (frame-tree),
      #30 (captioning) — all verified to merge cleanly into main.
- [ ] Redeploy `main` so the running app reflects merged fixes.

## Medium priority

- [ ] Add a "download local model" opt-in UX (progress indicator) for WebLLM
      and captioning.
- [ ] Feed frame-tree outline + captions into the planner prompt / chat
      grounding once #29 and #30 are merged.

## Low priority

- [ ] Expand unit tests for deterministic, non-GPU logic (engine, frame-tree,
      tool-decision validator).
- [ ] Document device-tier expectations (which models run where).

## Completed

- [x] (2026-06-10) Land the local chat + tool router + grounding system on
      `main` (was stranded on a stacked branch).
- [x] (2026-06-08) Create the persistent project-memory system
      (`memory/` + `AGENTS.md`).

> Add a date when you check something off, and consider a CHANGELOG entry for
> anything that changed behavior or structure.

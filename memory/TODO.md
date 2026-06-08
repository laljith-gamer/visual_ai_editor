# TODO

> Prioritized, actionable task list. Keep it short and current — move done
> items to **Completed** (and reflect notable ones in `CHANGELOG.md`).
> Larger directional items live in `ROADMAP.md`.
>
> Last updated: 2026-06-08

## High priority

- [ ] Decide the integration approach for the local-first chain and wire it
      behind a feature flag that defaults OFF (existing cloud flow unchanged).
- [ ] Get the foundational local-first PRs reviewed/merged to `main` so
      integration can be built cleanly.

## Medium priority

- [ ] Add a "download local model" opt-in UX (progress indicator) for WebLLM
      and captioning.
- [ ] Feed frame-tree outline + captions into the planner prompt as grounding.
- [ ] Resolve the expected `lib/config.ts` merge conflict between the
      captioning and local-LLM branches when both land.

## Low priority

- [ ] Expand unit tests for deterministic, non-GPU logic (engine, frame-tree).
- [ ] Document device-tier expectations (which models run where).

## Completed

- [x] (2026-06-08) Create the persistent project-memory system
      (`memory/` + `AGENTS.md`).

> Add a date when you check something off, and consider a CHANGELOG entry for
> anything that changed behavior or structure.

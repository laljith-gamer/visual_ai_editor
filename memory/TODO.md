# TODO

> Prioritized, actionable task list. Keep it short and current — move done
> items to **Completed** (and reflect notable ones in `CHANGELOG.md`).
> Larger directional items live in `ROADMAP.md`.
>
> Last updated: 2026-06-10

## High priority

- [ ] **Wire the merged local-first chat/tool system into the assistant UI**,
      behind a feature flag defaulting OFF. (`lib/llm/`, `lib/vision-core/`,
      `lib/frame-tree/`, `lib/vision/caption*` are all on main; UI integration
      + tool-decision execution is missing — this is THE production step.)
- [ ] Review/merge PR #33 (briefing follow-up fallback) so briefing chips
      stop hitting the generic clarify in the running app.
- [ ] Redeploy `main` so the running app reflects merged fixes.

## Medium priority

- [ ] Add a "download local model" opt-in UX (progress indicator) for WebLLM
      and captioning.
- [ ] Feed frame-tree outline + captions into the planner prompt / chat
      grounding (modules now on main).
- [ ] Structured briefing follow-ups: replace `followUps: string[]` with a
      `BriefingFollowUp` action union (promote/plan_topic/extract_range) so
      chips carry intent + skip `/api/agent` for promote. (Medium-term design
      from the PR #33 spec; P0 fallback shipped first.)

## Low priority

- [ ] Expand unit tests for deterministic, non-GPU logic (engine, frame-tree,
      tool-decision validator).
- [ ] Document device-tier expectations (which models run where).

## Completed

- [x] (2026-06-10) Briefing follow-up clarify fix — PR #33 (open): chips no
      longer hit the generic "what should the short be about?".
- [x] (2026-06-10) Merge frame-tree (#29), captioning (#30), temporal-pass
      fix (#28) to main.
- [x] (2026-06-10) Land the local chat + tool router + grounding system on
      `main` (was stranded on a stacked branch).
- [x] (2026-06-08) Create the persistent project-memory system
      (`memory/` + `AGENTS.md`).

> Add a date when you check something off, and consider a CHANGELOG entry for
> anything that changed behavior or structure.

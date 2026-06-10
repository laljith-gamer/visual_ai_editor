# TODO

> Prioritized, actionable task list. Keep it short and current — move done
> items to **Completed** (and reflect notable ones in `CHANGELOG.md`).
> Larger directional items live in `ROADMAP.md`.
>
> Last updated: 2026-06-10 (clarify briefing guard)

## High priority

- [ ] **Wire the merged local-first chat/tool system into the assistant UI**,
      behind a feature flag (`NEXT_PUBLIC_LOCAL_FIRST_EDITOR`) defaulting OFF.
      (`lib/llm/`, `lib/vision-core/`, `lib/frame-tree/`, `lib/vision/caption*`
      are all on main; UI integration + tool-decision execution is missing —
      this is THE production step.)
- [ ] **Structured briefing follow-ups** — replace `followUps: string[]` with a
      `BriefingFollowUp` action union (promote/plan_topic/extract_range/chat)
      so chips carry intent + skip `/api/agent` for promote. Normalize legacy
      string follow-ups generically (no keyword tables).

## Medium priority

- [ ] Add a "download local model" opt-in UX (progress indicator) for WebLLM
      and captioning.
- [ ] Feed frame-tree outline + captions into the planner prompt / chat
      grounding (modules now on main). Only with REAL frame data — never fake.

## Low priority

- [ ] Expand unit tests for deterministic, non-GPU logic (engine, frame-tree,
      tool-decision validator, synthesizeVaguePlan).
- [ ] Document device-tier expectations (which models run where).
- [ ] Extract focused hooks from the large `app/editor/page.tsx`
      (useAgentPlanner / useBriefingActions / usePipelineRunner) — only when
      touching related code, behavior-identical.

## Completed

- [x] (2026-06-10) Clarify-branch briefing guard + narrowed synthesizeVaguePlan
      (Bug 1 + Bug 2): the LLM's own `mode:"clarify"` now respects briefing
      context, and the fallback uses ONE grounded scenario instead of diluting
      intent across every best-part label.
- [x] (2026-06-10) Briefing follow-up clarify fix (PR #33, merged): chips no
      longer hit the generic "what should the short be about?".
- [x] (2026-06-10) Merge frame-tree (#29), captioning (#30), temporal-pass
      fix (#28), local chat/tool/grounding system to `main`.
- [x] (2026-06-08) Create the persistent project-memory system
      (`memory/` + `AGENTS.md`).

> Add a date when you check something off, and consider a CHANGELOG entry for
> anything that changed behavior or structure.

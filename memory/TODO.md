# TODO

> Prioritized, actionable task list. Keep it short and current — move done
> items to **Completed** (and reflect notable ones in `CHANGELOG.md`).
> Larger directional items live in `ROADMAP.md`.
>
> Last updated: 2026-06-11 (structured briefing follow-ups + safe local-first actions)

## High priority

- [ ] **Feed REAL frame data into local `plan` / `describe`.** Let the
      on-device router execute these using `lib/frame-tree/` +
      `lib/vision/caption*` (+ `lib/vision-core/` scoring) instead of
      deferring to cloud. Gated on building the sampled/captioned frame-tree
      for the active source and passing its outline into `routeTurn` /
      grounding. NEVER fake frame data — keep cloud fallback until it's real.
- [ ] **Extend safe local actions to `edit`.** `promote`/`extract`/`reset`
      now run locally behind the flag; map `ToolDecision.operation` onto the
      existing `EditOperation` store actions (trim/drop/split) next, same
      flag + confidence floor.
- [ ] **Browser/WebGPU verification** of the flag-ON path (local router
      executing promote/extract/reset + local chat). Needs a real GPU
      browser; not possible in the sandbox.
- [ ] **Redeploy** so the merged Phase 3 / 4.5 work reaches the running app.

## Medium priority

- [ ] Add a "download local model" opt-in UX (progress indicator) for WebLLM
      and captioning.
- [ ] Optionally have `/api/agent/briefing` emit structured `BriefingFollowUp`
      actions directly (client already normalizes strings, so this is a
      quality bump, not a requirement).

## Low priority

- [ ] Expand unit tests for deterministic, non-GPU logic (engine, frame-tree,
      tool-decision validator, `normalizeBriefingFollowUps`,
      synthesizeVaguePlan).
- [ ] Document device-tier expectations (which models run where).
- [ ] **Phase 5 (maintainability):** extract focused hooks from the large
      `app/editor/page.tsx` (`useAgentPlanner` / `useBriefingActions` /
      `useTimelineCommandRunner` / `usePipelineRunner` /
      `useAssistantController`) — only when touching related code,
      behavior-identical, not mixed with feature work.

## Completed

- [x] (2026-06-11) **Structured briefing follow-ups (Phase 3).**
      `BriefingFollowUp` union + `lib/briefing/followups.ts` normalizer;
      `BriefingCard`/`AssistantPanel`/editor wired to dispatch intent
      (promote/plan_topic/extract_range) deterministically, chat via the
      normal pipe. Backward compatible with string follow-ups; no clarify
      loop.
- [x] (2026-06-11) **Phase 4.5 — safe deterministic local-first actions.**
      `localFirst.ts` now executes `promote`/`extract`/`reset` on-device
      behind `NEXT_PUBLIC_LOCAL_FIRST_EDITOR`; everything else + low
      confidence + missing data fall through to the unchanged cloud planner.
- [x] (2026-06-11) **Phase 4 v1 — local-first chat wiring** confirmed on
      main: `routeTurn` + grounded `chat` run on-device behind the flag.
- [x] (2026-06-11) Removed a duplicated quick-shortcut `catch` block in
      `app/editor/page.tsx` that broke TypeScript parsing; typecheck passes.
- [x] (2026-06-10) Clarify-branch briefing guard + narrowed synthesizeVaguePlan
      (Bug 1 + Bug 2).
- [x] (2026-06-10) Briefing follow-up clarify fix (PR #33, merged).
- [x] (2026-06-10) Merge frame-tree (#29), captioning (#30), temporal-pass
      fix (#28), local chat/tool/grounding system to `main`.
- [x] (2026-06-08) Create the persistent project-memory system
      (`memory/` + `AGENTS.md`).

> Add a date when you check something off, and consider a CHANGELOG entry for
> anything that changed behavior or structure.

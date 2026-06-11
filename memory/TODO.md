# TODO

> Prioritized, actionable task list. Keep it short and current — move done
> items to **Completed** (and reflect notable ones in `CHANGELOG.md`).
> Larger directional items live in `ROADMAP.md`.
>
> Last updated: 2026-06-11 (added GitHub Actions CI + CHANGELOG cleanup)

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
- [ ] **Phase 5 (maintainability) — continue ONE hook at a time.** First
      extraction done (`hooks/useBriefingActions.ts`). Remaining candidates
      from `app/editor/page.tsx`: `useAgentPlanner`,
      `useTimelineCommandRunner`, `usePipelineRunner`,
      `useAssistantController`. Behavior-identical only; not mixed with
      feature work; no big rewrite.

## Completed

- [x] (2026-06-11) **Add GitHub Actions CI** (`.github/workflows/ci.yml`).
      Runs `npm run typecheck` + `npm run build` on PRs to `main` and pushes
      to `main` (Ubuntu, Node 20, npm cache, `npm ci`). Lint intentionally
      excluded (no ESLint config; `next lint` is interactive). Browser/WebGPU
      verification stays manual.

- [x] (2026-06-11) **Phase 4.5 polish — briefing `plan_topic` preserves
      `sourceId`.** Client-side plan now passes `sources:[action.sourceId]`
      into `normalizePlan`, so multi-source briefings stay grounded on the
      briefed source. No cloud call, no category logic.
- [x] (2026-06-11) **Phase 5 first extraction — `hooks/useBriefingActions.ts`.**
      Pulled the deterministic briefing follow-up handler out of
      `app/editor/page.tsx`, behavior-identical; page calls the hook.
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

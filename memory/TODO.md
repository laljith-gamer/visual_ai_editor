# TODO

> Prioritized, actionable task list. Keep it short and current — move done
> items to **Completed** (and reflect notable ones in `CHANGELOG.md`).
> Larger directional items live in `ROADMAP.md`.
>
> Last updated: 2026-06-11 (removed browser WebLLM; server-side OpenRouter provider)

## High priority

- [ ] **Validate OpenRouter end-to-end (real deployment).** With
      `OPENROUTER_API_KEY` set: `/api/agent` returns valid planner JSON;
      multimodal briefing / "describe" works (default
      `google/gemini-2.5-flash`); briefing chips + promote/extract/reset
      still work; and with the key unset / on failure it falls back to direct
      Gemini/Groq. Confirm no browser model download and the key never
      appears client-side.
- [ ] **Browser/WebGPU + live-API verification.** The cloud chat/vision path
      and on-device SigLIP/Whisper/captioning need a real GPU browser + real
      API keys; not possible in the sandbox.
- [ ] **Redeploy** so the OpenRouter migration reaches the running app. Set
      `OPENROUTER_API_KEY` (and optionally `APP_URL`, `OPENROUTER_*_MODEL`)
      in the deployment environment.

## Medium priority

- [ ] Optionally route `/api/vision/frame` + `/api/vision/window` through the
      `cloudVisionJson` dispatcher too (left out of the OpenRouter migration
      to keep scope tight; they still call Gemini directly).
- [ ] Optionally have `/api/agent/briefing` emit structured `BriefingFollowUp`
      actions directly (client already normalizes strings, so this is a
      quality bump, not a requirement).

## Low priority

- [ ] Expand unit tests for deterministic, non-GPU logic (frame-tree,
      `normalizeBriefingFollowUps`, synthesizeVaguePlan, and the
      `lib/providers/cloud.ts` provider-order selection).
- [ ] Document device-tier expectations (which models run where).
- [ ] **Phase 5 (maintainability) — continue ONE hook at a time.** First
      extraction done (`hooks/useBriefingActions.ts`). Remaining candidates
      from `app/editor/page.tsx`: `useAgentPlanner`,
      `useTimelineCommandRunner`, `usePipelineRunner`,
      `useAssistantController`. Behavior-identical only; not mixed with
      feature work; no big rewrite.

## Completed

- [x] (2026-06-11) **Removed browser WebLLM; server-side OpenRouter provider.**
      Deleted `lib/llm/*` + `@mlc-ai/web-llm` + `LOCAL_LLM`/`LOCAL_FIRST` +
      `NEXT_PUBLIC_LOCAL_FIRST_EDITOR` + the editor's local-first gate +
      `executeLocalFirstAction` + the apply-local-first workflow. Added
      `lib/providers/openrouter.ts` (server-only) + `lib/providers/cloud.ts`
      dispatcher (OpenRouter → Gemini → Groq); `/api/agent`,
      `/api/agent/briefing`, `/api/vision/clip` route through it. Key is
      server-only (no `NEXT_PUBLIC_OPENROUTER_API_KEY`, verified absent from
      client bundle); no browser model download; deterministic client actions
      kept; Gemini remains the vision fallback; no fake vision data.
      `npm install`/`typecheck`/`build` ✓.
- [x] (2026-06-11) **Local-first high-tier model → Hermes-3-Llama-3.1-8B.**
      `LOCAL_LLM` in `lib/config.ts` now uses Hermes-3-Llama-3.1-8B
      (`q4f16_1-MLC`) for the high tier (WebLLM function-calling/tool-use
      model), Qwen2.5-3B for mid, Llama-3.2-1B for low; added additive
      `roles` metadata. Gemini still required as cloud planner + vision
      fallback; flag default still OFF; no cloud-flow change; no fake vision
      data. Full Gemini-optional still needs real frame-tree/caption/vision-
      core grounding.
- [x] (2026-06-11) **Briefing endpoint resilience.** `/api/agent/briefing`
      retries once with fewer frames + a stricter compact prompt when the
      first Gemini response is unparseable, and degrades to a minimal 200
      fallback `BriefingResult` instead of a dead-end error. Safe logging
      (truncated model text, no base64/video). No UI/ffmpeg/scoring changes.
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

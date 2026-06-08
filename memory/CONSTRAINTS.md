# CONSTRAINTS

> Hard rules every contributor — **especially AI assistants** — must follow
> on this repository. If a request conflicts with a constraint, pause and
> confirm with the user before proceeding.

## Default constraints (always apply)

1. **Do not hardcode unless necessary.** Prefer configuration, constants, or
   parameters over magic values. When a constant is unavoidable, put it in a
   sensible config location (e.g. `lib/config.ts`) and comment why.
2. **Do not change working logic unless explicitly asked.** Behavior-
   preserving refactors are fine when requested; silent behavior changes are
   not.
3. **Prefer simple, readable code.** Optimize for the next human (or AI)
   reading it. Clarity beats cleverness.
4. **Prefer free or low-cost tools where possible.** This project is built to
   run on free tiers and on-device. Avoid introducing paid services or heavy
   dependencies without explicit approval.
5. **Explain architecture before making large code changes.** Summarize the
   plan and the affected areas, and get confirmation, before big edits.
6. **Keep project memory updated when major decisions are made.** Update the
   relevant files in `memory/` (PROJECT_STATE, DECISIONS, TODO, CHANGELOG)
   as part of the work, not as an afterthought.

## Project-specific constraints

- **Never upload the user's video off-device.** The architecture guarantees
  video bytes stay in the browser; server routes proxy LLM text/JSON only.
- **Don't break the existing cloud (Gemini/Groq) flow.** New local-first
  features must be additive and, when wired in, gated behind a flag that
  defaults to the current behavior.
- **WebGPU features can't be verified in CI/headless.** Typecheck and unit-
  test what you can, but clearly state that browser+GPU runtime verification
  is pending and must be done by the user.
- **Run `npm install` before trusting a typecheck.** Some environments start
  with no `node_modules`, which hides missing-dependency type errors.
- **Respect the rate-limit / cost guards.** Don't remove or weaken the
  rate-limiting layers or the graceful-degradation paths.

## Working-style rules for AI agents

- **Never overwrite or delete user code without explicit permission.**
- Read before you edit: never propose changes to a file you haven't read.
- Keep pull requests focused and independently reviewable.
- Be honest about what was actually verified vs. assumed.

> Add new constraints here as the project establishes them. Do not silently
> relax an existing constraint — note the change in DECISIONS.md.

# ROADMAP

> Where the project is headed. Phases are roughly sequential but can overlap.
> Keep this aligned with `PROJECT_STATE.md` (next step) and `TODO.md`
> (concrete tasks). Update as priorities shift.
>
> Last updated: 2026-06-08

## Phase 1 — Foundations (in progress)

- Build the local-first building blocks as additive library modules:
  - Offline deterministic reasoning engine (`lib/vision-core`).
  - In-browser frame-organization tree (`lib/frame-tree`).
  - Optional in-browser frame captioning (`lib/vision/caption*`).
  - Local WebLLM planner (`lib/llm`).
- Fix correctness/perf issues found during audit (e.g. temporal-pass range).
- Get these reviewed and merged to `main`.

## Phase 2 — Integration

- Wire the local-first chain end to end, behind a feature flag that
  **defaults to the existing cloud behavior**:
  `grammar shortcut → deterministic engine → local LLM → optional cloud`.
- Feed the frame-tree + captions into the reasoning engine and the planner
  prompt as grounding context.
- Add a "download local model" UX (progress, opt-in) for WebLLM/captioning.

## Phase 3 — Hardening & UX

- Runtime-verify all WebGPU paths in real browsers across device tiers.
- Tune model tiers and thresholds for quality vs. speed.
- Improve graceful degradation when WebGPU/model load fails.
- Expand test coverage for the deterministic, non-GPU logic.

## Future improvements (backlog / ideas)

- Multi-language captioning / transcription.
- Smarter scene/chapter summarization in the frame-tree.
- Optional fully-offline mode (no cloud at all) as a first-class setting.
- Shareable, resumable project state.

> Move items into TODO.md with priorities when they become actionable.

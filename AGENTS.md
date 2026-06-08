# AGENTS

Guidance for AI coding agents (ChatGPT, Claude, Codex, Kiro, and others)
working in this repository.

## Project Memory Instructions

This repository has a persistent project memory in the [`memory/`](./memory)
folder. **Follow this protocol at the start of every session and before any
non-trivial change.**

### On session start

1. **First, read [`memory/INDEX.md`](./memory/INDEX.md).** It is the entry
   point and defines the reading order.
2. **Then read all files it lists**, in order:
   1. [`memory/PROJECT_STATE.md`](./memory/PROJECT_STATE.md)
   2. [`memory/DECISIONS.md`](./memory/DECISIONS.md)
   3. [`memory/CONSTRAINTS.md`](./memory/CONSTRAINTS.md)
   4. [`memory/ROADMAP.md`](./memory/ROADMAP.md)
   5. [`memory/TODO.md`](./memory/TODO.md)
   6. [`memory/CHANGELOG.md`](./memory/CHANGELOG.md)
3. **Treat `memory/PROJECT_STATE.md` as the source of truth** for the
   project's status, architecture, and next best step. If the code and the
   memory disagree, trust the code — then update the memory to match.

### Before editing code

- **Summarize the current project state** (from `PROJECT_STATE.md`) back to
  the user, and confirm your plan — especially before large changes.
- **Read files before editing them.** Never propose changes to code you have
  not read.
- **Honor `memory/CONSTRAINTS.md`.** If a request conflicts with a
  constraint, pause and confirm.

### After major changes

- **Suggest updates to the memory files** so the next session inherits your
  progress. Typically:
  - `PROJECT_STATE.md` — new status / architecture / next step.
  - `DECISIONS.md` — any notable decision and its reasoning.
  - `TODO.md` — check off completed items, add new ones.
  - `CHANGELOG.md` — a dated entry of what changed and why.

### Hard rules

- **Never overwrite or delete user code without explicit permission.**
- Keep changes additive and focused where possible.
- Be honest about what was actually verified versus assumed (e.g. note when
  browser/GPU runtime verification is still pending).

> If this file is extended in the future, keep this "Project Memory
> Instructions" section intact and append new sections below it rather than
> replacing it.

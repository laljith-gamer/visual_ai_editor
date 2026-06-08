# Project Memory — INDEX

> **Read me first.** This is the entry point to the project's persistent
> memory. If you are an AI assistant (ChatGPT / Claude / Codex / Kiro or
> any other) starting a new session on this repository, **read this file
> before doing anything else**, then read the other memory files in the
> order listed below.

## What this is

This `memory/` folder is a small, human-readable knowledge base that lets a
fresh AI session quickly understand the project's current state, the
decisions already made, the rules it must follow, and what to do next —
without re-deriving everything from the source code.

It is **documentation only**. It never replaces reading the actual code, but
it tells you *where to look* and *what is already true* so you continue from
the correct state instead of guessing.

## Reading order (do this in sequence)

1. **[PROJECT_STATE.md](./PROJECT_STATE.md)** — the single source of truth for
   what the project is, its current status, architecture, and the next best
   step. Start here after this index.
2. **[DECISIONS.md](./DECISIONS.md)** — important technical/product decisions
   already made, and why. Do not re-litigate these without reason.
3. **[CONSTRAINTS.md](./CONSTRAINTS.md)** — hard rules every contributor (human
   or AI) must follow.
4. **[ROADMAP.md](./ROADMAP.md)** — where the project is headed (phases +
   future ideas).
5. **[TODO.md](./TODO.md)** — concrete tasks, prioritized.
6. **[CHANGELOG.md](./CHANGELOG.md)** — a log of notable changes over time.

## How to use this memory

- Treat **PROJECT_STATE.md** as authoritative. If code and memory disagree,
  trust the code, then **update the memory** to match.
- Before making large changes, summarize the current state (from
  PROJECT_STATE.md) back to the user and confirm the plan.
- After completing meaningful work, **propose updates** to the relevant
  memory files (PROJECT_STATE, DECISIONS, TODO, CHANGELOG) so the next
  session inherits your progress.
- Keep entries short, dated, and factual. This is a working memory, not a
  marketing document.

## File map

| File | Purpose |
|------|---------|
| `INDEX.md` | This file — entry point + reading order. |
| `PROJECT_STATE.md` | Source of truth: what/where/status/next step. |
| `DECISIONS.md` | Why things are the way they are. |
| `CONSTRAINTS.md` | Rules that must not be broken. |
| `ROADMAP.md` | Planned phases + future improvements. |
| `TODO.md` | Prioritized task list. |
| `CHANGELOG.md` | Dated history of notable changes. |

See also **[../AGENTS.md](../AGENTS.md)** for the short operating protocol AI
agents should follow on this repo.

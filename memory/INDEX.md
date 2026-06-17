# Project Memory — INDEX

> **Read this first.** This folder is the handoff brain for the repo. A fresh AI/helper session should read this file before making changes, then follow the reading order below.
>
> Last organized: **2026-06-18** — offline fast-editor note indexed
> (fast command routing, agent-memory persistence, storage budget,
> transcript error honesty).

---

## 1. What this folder is

`memory/` is a small human-readable knowledge base for the project. It captures:

- the current source-of-truth state,
- hard constraints,
- active TODOs,
- roadmap direction,
- major decisions,
- dated historical notes.

It is documentation only. It does not replace reading the actual code before editing code.

---

## 2. Reading order

Read these in sequence:

1. **[PROJECT_STATE.md](./PROJECT_STATE.md)** — current source of truth: goal, status, architecture, known issues, next best step.
2. **[CONSTRAINTS.md](./CONSTRAINTS.md)** — hard rules that must not be broken.
3. **[TODO.md](./TODO.md)** — active prioritized work.
4. **[ROADMAP.md](./ROADMAP.md)** — larger phased direction.
5. **[DECISIONS.md](./DECISIONS.md)** — why previous technical/product choices were made.
6. **[CHANGELOG.md](./CHANGELOG.md)** — detailed historical log of earlier project/memory changes.
7. Dated context notes below — use these for background after reading the active source-of-truth files.

---

## 3. Active source-of-truth files

| File | Purpose | Status |
|------|---------|--------|
| `PROJECT_STATE.md` | Current repo/product state and next best step. | **Authoritative** |
| `CONSTRAINTS.md` | Rules for code, privacy, AI work, and memory-only requests. | **Authoritative** |
| `TODO.md` | Prioritized tasks. | **Active** |
| `ROADMAP.md` | Direction by phase. | **Active** |
| `DECISIONS.md` | Decision history and rationale. | Historical + active reference |
| `CHANGELOG.md` | Detailed change history. | Historical reference |

---

## 4. Dated context notes

These files are snapshots. They explain how the project reached the current state, but they should not override `PROJECT_STATE.md`.

### Product goal and production direction

| File | Use when you need |
|------|-------------------|
| `PROJECT_GOAL_BROWSER_FIRST_HYBRID_2026-06-16.md` | Current product direction: browser-first hybrid local AI video editor. |
| `PRODUCTION_VIDEO_OPTIMIZATION_2026-06-15.md` | Long-video production optimization target and adaptive sampling context. |

### Offline/local video understanding and memory

| File | Use when you need |
|------|-------------------|
| `OFFLINE_FIRST_ANALYSIS_PLAN_2026-06-15.md` | 0–5 minute offline-first analysis contract and tree-memory design. |
| `VIDEO_MEMORY_FOUNDATION_2026-06-16.md` | First persistent video-memory foundation summary. |
| `OFFLINE_VIDEO_UNDERSTANDING_STEP1_2026-06-16.md` | Step 1: scored frames → FrameTree → VideoMemoryIndex persistence. |
| `LOCAL_MODEL_CSP_AND_TREE_MEMORY_2026-06-16.md` | Local model CSP fixes and tree-memory wiring state. |
| `LOCAL_ONLY_UI_AND_CSP_FIXES_2026-06-16.md` | Local-only UI badge, CSP, and deterministic fallback fixes. |

### Runtime / deployment diagnostics

| File | Use when you need |
|------|-------------------|
| `RUNTIME_CONSOLE_FIXES_2026-06-17.md` | DevTools/runtime warning triage: manifest 401, Canvas2D readback hint, SigLIP dtype warning. |

### Agentic editing layer

| File | Use when you need |
|------|-------------------|
| `AGENTIC_INTENT_LAYER_2026-06-17.md` | Deterministic agent: natural-command parsing (`lib/intent`), agent memory + reinforcement (`lib/agent-memory`), timeline ops (`lib/timeline`), orchestrator + concept/OCR resolution (`lib/agent`, `lib/ocr`), and how it's wired before the cloud planner. |
| `OFFLINE_FAST_EDITOR_2026-06-18.md` | Offline fast-editor pass: fast control-command routing (`lib/intent/fastCommands`), store redo, agent-memory IndexedDB persistence (`lib/agent-memory/persistence`, `getRelevantMemory`), storage budget+manager (`lib/storage/*`), and explicit transcription errors. |
| `PR57_PRODUCTION_TOOL_RELIABILITY_2026-06-19.md` | Issue #57 PR 57: reliable export/download (`lib/util/download`, `hooks/useExport`, deterministic filename, blocked fallback), render-vs-export split + pure `decideFastAction` in `lib/intent/fastCommands`. |
| `PR58_TRANSITION_FOUNDATION_2026-06-19.md` | Issue #57 PR 58: per-boundary transition model + honest mapping (`lib/transitions/{types,map}`, `TRANSITIONS` config). Foundation only — render/UI/chat wiring is a follow-up. |
| `PR59_AUTO_TRANSITIONS_2026-06-19.md` | Auto transition picking: offline evidence-based selector (`lib/transitions/{features,auto,timeline}`), store/UI (`TransitionsBar`)/chat (`transitionCommands`) wiring, and per-boundary render (`lib/pipeline/renderFilters` + worker/mediabunny). Honest mapping kept; true xfade deferred. |
| `QUESTION_ROUTING_FIX_2026-06-19.md` | Questions ("describe this video", "why did you pick these clips") answered offline from the editor's own data (`lib/agent/questionAnswer.ts`) + `deriveIntent` stopword hardening — never turned into clip searches/builds. |

### Training / future model direction

| File | Use when you need |
|------|-------------------|
| `DOMAIN_MODEL_TRAINING_2026-06-15.md` | Planner-model fine-tuning direction, dataset format, and evaluation metrics. |

---

## 5. Maintenance rules

- Keep `PROJECT_STATE.md` short and current. It should describe the latest state, not every historical detail.
- Keep dated files as historical snapshots unless a correction is needed.
- When work changes the repo, update the relevant active memory files in the same work session.
- If code and memory disagree, trust the code, then update memory to match after reading the code.
- When the user asks to organize or update only `memory/`, do not edit app code, UI, backend, workflows, dependencies, or unrelated files.

See also **[../AGENTS.md](../AGENTS.md)** for the repo-level AI operating protocol.

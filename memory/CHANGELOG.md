# CHANGELOG (project memory)

> A dated log of **notable changes** to the project and its memory. This is a
> lightweight, human-readable history — not a replacement for git history or
> the app's own product changelog (`/CHANGELOG.md` at the repo root).
>
> Newest entries at the **top**. Keep each entry concise.

## Entry format

```
### YYYY-MM-DD — Short title
- **Change made:** what happened.
- **Files affected:** key paths.
- **Reason:** why.
```

---

### 2026-06-11 — Structured briefing follow-ups + safe local-first actions (Phase 3 complete, Phase 4.5)
- **Change made:**
  1. **Structured briefing follow-ups (Phase 3 — now done).** Replaced the
     plain-string follow-up chips with an intent-carrying
     `BriefingFollowUp` union (`promote` | `plan_topic` | `extract_range` |
     `chat`). Briefing chips no longer round-trip through the cloud planner
     as raw text, which is what caused the "what should the short be about?"
     clarify loop. New pure normalizer `lib/briefing/followups.ts` upgrades
     legacy/string follow-ups into actions (generic "use these moments"
     heuristic → `promote`; otherwise `plan_topic` grounded in the briefing;
     NO genre/keyword tables). `BriefingResult.followUps` now accepts
     `Array<string | BriefingFollowUp>` (backward compatible with the
     briefing API and old saved sessions). `BriefingCard` + `AssistantPanel`
     dispatch structured actions; the editor runs them deterministically
     (promote → `promoteBriefingParts`; plan_topic → client-side
     `normalizePlan` + pending execution, never clarify; extract_range →
     `buildExtractedHighlight`). `chat` still goes through the normal pipe.
  2. **Phase 4.5 — safe deterministic local-first actions.** `localFirst.ts`
     now executes a closed set of low-risk router decisions on-device behind
     the flag: `promote`, `extract`, `reset` (each maps onto an existing
     tested store path / pure builder, above `LOCAL_FIRST.minActionConfidence`).
     `plan`/`moment`/`edit`/`merge`/`describe` and any low-confidence/missing-
     data case still FALL THROUGH to the unchanged cloud planner (no faked
     frame-tree/vision data). `chat` local handling is unchanged.
- **Files affected:** `lib/types.ts` (BriefingFollowUp + BriefingResult),
  `lib/briefing/followups.ts` (new), `lib/config.ts`
  (`BRIEFING_FOLLOWUP`, `LOCAL_FIRST.minActionConfidence`),
  `components/BriefingCard.tsx`, `components/AssistantPanel.tsx`,
  `app/editor/page.tsx` (`handleBriefingAction`, `executeLocalFirstAction`,
  local-first gate), `lib/llm/localFirst.ts`; `memory/*`.
- **Reason:** Make briefing chips product-quality (carry intent, run
  deterministically) and complete the safe slice of local-first action
  execution without breaking the cloud flow.
- **Validation:** `npm install` ✓, `npm run typecheck` ✓, `npm run build` ✓
  (only a pre-existing `@huggingface/transformers` `import.meta` warning).
  `npm run lint` is NOT separately configured in this repo (`next lint`
  prompts for interactive setup; eslint deps exist but no config file) — the
  build's own type+lint pass is green. Browser/WebGPU runtime (local router
  executing actions) NOT verified — no GPU in sandbox; needs a real browser
  with `NEXT_PUBLIC_LOCAL_FIRST_EDITOR=true`. No CI workflow run.


- **Change made:** Removed a duplicated quick-shortcut `catch` block in
  `app/editor/page.tsx` that caused TypeScript parser errors and cascade
  declaration errors.
- **Files affected:** `app/editor/page.tsx`, `memory/PROJECT_STATE.md`,
  `memory/TODO.md`, `memory/CHANGELOG.md`.
- **Reason:** Restore a clean `tsc --noEmit` check without changing editor
  behavior.
- **Validation:** `npm.cmd run typecheck` passes.

### 2026-06-10 — Clarify-branch briefing guard + narrowed plan synthesis
- **Change made:** (Bug 1) The `mode === "clarify"` branch in
  `app/api/agent/route.ts` now also synthesizes a briefing-grounded plan
  when a briefing is in scope AND the user gave a topic — previously only
  the plan/moment branch did this, so a direct LLM `mode:"clarify"` could
  still ask "what should the short be about?" after a briefing chip.
  (Bug 2) `synthesizeVaguePlan` no longer adds every best-part label as a
  separate ~equal scenario (which diluted specific requests). It now builds
  ONE scenario = user text + a compact context phrase from ≤3 best-part
  labels, with semantic-heavy signals (0.65/0.2/0.15). New `SYNTH_PLAN`
  config constants (no magic numbers). Also corrected stale memory: PR #33
  is MERGED, not open.
- **Files affected:** `app/api/agent/route.ts`, `lib/config.ts`;
  `memory/PROJECT_STATE.md`, `memory/TODO.md`, `memory/CHANGELOG.md`.
- **Reason:** Close the remaining clarify hole and stop specific briefing
  follow-ups from being broadened into wrong clips. Deterministic safety
  around the LLM; generic (no genre/keyword tables).
- **Validation:** typecheck ✓, production build ✓, 8/8 logic unit checks ✓.
  Browser/GPU not verified (sandbox has no GPU).

### 2026-06-10 — Briefing follow-up clarify fix (PR #33) + memory sync
- **Change made:** Fixed the P0 bug where tapping a briefing follow-up chip
  (e.g. "Show all ingredient preparation clips") could return the generic
  "what should the short be about?" clarify. The plan/moment fallback in
  `app/api/agent/route.ts` now synthesizes a plan when a briefing is in scope
  AND the user gave a topic (not only after a prior clarify), grounding the
  scenario in the user's text + the briefing's best-part labels. Also
  corrected this memory: #28/#29/#30 are now confirmed MERGED to main (the
  earlier "still open" note was stale).
- **Files affected:** `app/api/agent/route.ts` (PR #33);
  `memory/PROJECT_STATE.md`, `memory/CHANGELOG.md`, `memory/TODO.md`,
  `memory/CONSTRAINTS.md` (this sync).
- **Reason:** Briefing chips always carry a concrete topic and the app
  already knows the video — re-asking was wrong. Deterministic safety around
  the LLM so product-critical UX doesn't depend only on prompt obedience.
- **Open:** PR #33 (not yet merged). **Merged since last entry:** #28
  (temporal fix), #29 (frame-tree), #30 (captioning).

### 2026-06-10 — Local chat/tool system merged to main; memory synced
- **Change made:** The capable local-first language layer landed on `main`:
  WebLLM engine + streaming chat + model-driven **tool router** (replaces the
  keyword/regex intent matching) + briefing "why" grounding, plus the
  deterministic `lib/vision-core` engine. Synced the memory files to reflect
  this (PROJECT_STATE status/module-table/next-step, TODO).
- **Files affected:** `lib/llm/*`, `lib/vision-core/*` (code, prior PRs);
  `memory/PROJECT_STATE.md`, `memory/TODO.md`, `memory/CHANGELOG.md` (this
  sync).
- **Reason:** Memory had gone stale — it still said the local-first modules
  were "on PRs / not on main." They are now merged (UI wiring still pending).
- **Still open (not on main):** PR #28 temporal-pass fix, #29 frame-tree,
  #30 captioning.

### 2026-06-08 — Add persistent project-memory system
- **Change made:** Created the `memory/` knowledge base (INDEX, PROJECT_STATE,
  DECISIONS, CONSTRAINTS, ROADMAP, TODO, CHANGELOG) and added an AI operating
  protocol to `AGENTS.md`.
- **Files affected:** `memory/*.md`, `AGENTS.md`.
- **Reason:** Let future AI sessions read repo context first and continue from
  the correct state. Documentation only — no application code changed.

> Add new entries above this line as changes happen.

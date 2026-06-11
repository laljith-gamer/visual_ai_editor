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

### 2026-06-11 — Add CLOUD_PROVIDER_ORDER env var to toggle/re-order providers
- **Change made:** Added an optional **server-only** `CLOUD_PROVIDER_ORDER`
  env var so you can toggle between providers (and set fallback order)
  without code changes or removing API keys. Comma-separated provider names
  (`openrouter | gemini | groq`); e.g. `CLOUD_PROVIDER_ORDER=gemini` forces
  Gemini only, `=openrouter` forces OpenRouter only, `=gemini,openrouter`
  prefers Gemini with OpenRouter fallback. Unknown/duplicate tokens are
  ignored; unset → the config default (`openrouter,gemini,groq`).
  - `lib/env.ts` — read `CLOUD_PROVIDER_ORDER` into `serverEnv` (server-only,
    not `NEXT_PUBLIC_*`).
  - `lib/providers/cloud.ts` — new `configuredOrder()` (env override →
    config default, validated/deduped) feeds `providerOrder()`. A provider is
    still only used if its key is set; Groq stays text-only (skipped for
    vision); per-provider circuit recording unchanged.
  - `.env.example` — documented the toggle with examples.
- **Files affected:** `lib/env.ts`, `lib/providers/cloud.ts`, `.env.example`;
  `memory/*`.
- **Reason:** Let the operator switch between OpenRouter and Gemini (or pin a
  single provider) at deploy time without editing code.
- **Validation:** `npm run typecheck` ✓, `npm run build` ✓. No browser WebLLM;
  keys remain server-only; no new logging.

---

### 2026-06-11 — Removed browser WebLLM; cloud routing via server-side OpenRouter
- **Change made:** Retired the in-browser WebLLM / WebGPU local language +
  tool-routing path and replaced cloud language/tool routing with a
  **server-side OpenRouter** provider (Gemini/Groq kept as fallbacks).
  - **Removed:** the entire `lib/llm/*` (engine, chat, tools, localFirst,
    grounding, prompt, types, index, `webllm.worker.ts`); the
    `@mlc-ai/web-llm` dependency; `LOCAL_LLM` + `LOCAL_FIRST` config; the
    `NEXT_PUBLIC_LOCAL_FIRST_EDITOR` flag + the editor's local-first gate +
    `executeLocalFirstAction`; the CSP `raw.githubusercontent.com` entry
    (only there for WebLLM model libs); and the one-time
    `.github/workflows/apply-local-first-once.yml` (which re-injected the
    WebLLM wiring). No more in-browser model download.
  - **Added:** `lib/providers/openrouter.ts` — server-only,
    OpenAI-compatible client (`openrouterJson`, `openrouterMultiImageJson`);
    `Authorization: Bearer OPENROUTER_API_KEY`, `X-Title: Shorts Studio`,
    optional `HTTP-Referer` (APP_URL / NEXT_PUBLIC_APP_URL); JSON-object mode
    + `extractJsonObject` parse fallback. Plus `lib/providers/cloud.ts` — a
    dispatcher (`cloudPlannerJson`, `cloudVisionJson`, `primaryProvider`)
    that walks `CLOUD_PROVIDER_ORDER = ["openrouter","gemini","groq"]`, skips
    providers with no key (Groq excluded from vision), and records each
    provider's circuit success/failure. New `OPENROUTER` config block; new
    env (`OPENROUTER_API_KEY`, `OPENROUTER_DEFAULT_MODEL=google/gemini-2.5-flash`,
    `OPENROUTER_CHEAP_MODEL=google/gemini-2.5-flash-lite`,
    `OPENROUTER_PREMIUM_MODEL=anthropic/claude-sonnet-4.5`,
    `OPENROUTER_OSS_MODEL=qwen/qwen3-coder`, `APP_URL`); `hasOpenRouter()` +
    `hasAnyVisionProvider()`; `Provider` circuit type gains `"openrouter"`.
  - **Routes:** `/api/agent` planner JSON now goes through `cloudPlannerJson`
    (OpenRouter→Gemini→Groq), preserving `normalizePlan` + every mode
    (clarify/briefing/promote/extract/edit/merge/describe). `/api/agent/briefing`
    and `/api/vision/clip` use `cloudVisionJson` (OpenRouter multimodal →
    Gemini direct); the briefing retry/minimal-fallback logic is intact.
- **Security (hard rules honoured):** the OpenRouter key is **server-only**
  (`serverEnv.OPENROUTER_API_KEY`); there is **no** `NEXT_PUBLIC_OPENROUTER_API_KEY`;
  verified the key name + `openrouter.ai` do **not** appear in the client
  bundle (`.next/static`); providers never log the key, prompts, or base64
  frames. Full video bytes still never leave the browser — only the
  already-sampled frames go to the cloud vision routes (destination can now
  be OpenRouter instead of Google directly).
- **Honesty:** OpenRouter does NOT fully replace Gemini vision — it handles
  vision only when the configured model is multimodal (the default
  `google/gemini-2.5-flash` is); otherwise it falls back to direct Gemini.
  No fake frame-tree/caption/vision data was added. The app is **no longer
  offline / local-LLM** — language routing is cloud-only now.
- **Kept (deterministic, non-model client paths):** structured briefing
  follow-ups (`lib/briefing/followups.ts`, `hooks/useBriefingActions.ts`),
  the grammar quick-shortcut gate (`lib/intent/*`), and promote/extract/reset
  (via the cloud planner's modes + existing client handlers).
- **Files affected:** `lib/providers/openrouter.ts` (new),
  `lib/providers/cloud.ts` (new), `lib/config.ts`, `lib/env.ts`,
  `lib/ratelimit/circuit.ts`, `app/api/agent/route.ts`,
  `app/api/agent/briefing/route.ts`, `app/api/vision/clip/route.ts`,
  `app/editor/page.tsx`, `package.json`, `package-lock.json`, `.env.example`,
  deleted `lib/llm/*` + the apply-local-first workflow; `memory/*`.
- **Reason:** WebLLM meant multi-GB browser downloads, WebGPU/device
  instability, and poor universal support; a server-side OpenRouter API is
  simpler, universal, and keeps keys off the browser.
- **Validation:** `npm install` ✓ (removed 2 packages), `npm run typecheck` ✓,
  `npm run build` ✓ (only the pre-existing `@huggingface/transformers`
  `import.meta` warning; `/editor` bundle 47.8 → 47.2 kB). Live OpenRouter
  calls + browser manual tests NOT run here (no key / browser in sandbox).

---

### 2026-06-11 — Local-first high-tier model → Hermes-3-Llama-3.1-8B (agentic/tool-use)
- **Change made:** Re-tiered the local WebLLM model choices in
  `lib/config.ts` (`LOCAL_LLM`) so the high tier prefers a model WebLLM
  explicitly supports for function-calling/tool-use:
    - **high:** `Hermes-3-Llama-3.1-8B-q4f16_1-MLC` (was
      `Qwen2.5-3B-Instruct-q4f16_1-MLC`) — Hermes-3 is on WebLLM's
      `functionCallingModelIds` list (verified against the prebuilt
      `model_list`; ~4.9 GB VRAM, `low_resource_required: false`), so the
      flag-gated local tool router (`lib/llm/tools.ts`) gets more reliable
      JSON tool decisions.
    - **mid:** `Qwen2.5-3B-Instruct-q4f16_1-MLC` (the previous high-tier
      model, kept as a strong/lighter fallback).
    - **low:** `Llama-3.2-1B-Instruct-q4f16_1-MLC` (unchanged).
    - Dropped the old `Qwen2.5-1.5B-Instruct-q4f16_1-MLC` mid entry.
  Added an **additive** `roles` metadata block
  (`agenticToolModel`/`fastPlannerModel`/`tinyFallbackModel`) for
  documentation + future allowlisting; the runtime tier→model selectors in
  `lib/llm/engine.ts` and `lib/llm/tools.ts` still read
  `modelHigh`/`modelMid`/`modelLow` directly, so the runtime stays simple and
  unchanged. Comments document the Hermes rationale, the Qwen mid fallback,
  and the **vision caveat**.
- **What did NOT change (by design):** Gemini is **not** removed — it remains
  the cloud planner AND the **vision briefing** fallback. These local LLMs do
  language/tool routing only; they do **not** replace Gemini vision. Full
  Gemini-optional requires REAL local frame-tree + caption grounding
  (`lib/frame-tree`, `lib/vision/caption*`, `lib/vision-core`) to be wired —
  no fake frame/vision data was added. `NEXT_PUBLIC_LOCAL_FIRST_EDITOR`
  default stays **OFF**; the cloud fallback path is byte-for-byte unchanged.
  `app/api/agent/briefing`, ffmpeg/render/scoring/sampling, and Phase 5 were
  intentionally untouched.
- **Files affected:** `lib/config.ts` (`LOCAL_LLM` only); `memory/*`.
- **Reason:** Better agentic/tool-use behaviour on the local-first path by
  using a model WebLLM officially supports for function-calling, without
  weakening or removing the cloud Gemini flow.
- **Validation:** `npm install` ✓, `npm run typecheck` ✓, `npm run build` ✓
  (see CHANGELOG validation note / final report for status). Hermes-8B
  loading + tool-routing quality is NOT verified here — needs a real WebGPU
  browser with `NEXT_PUBLIC_LOCAL_FIRST_EDITOR=true` (no GPU in sandbox).

---

### 2026-06-11 — Briefing endpoint: retry-once + minimal fallback (resilience fix)
- **Change made:** Fixed the live bug where "Describe what's in this video"
  could dead-end on *"The video summary came back incomplete…"* whenever
  Gemini reached the endpoint but returned text `extractJsonObject()` couldn't
  parse (truncated/wrapped JSON from thinking-heavy/overloaded models).
  `app/api/agent/briefing/route.ts` now:
  1. **Retries once** when the first parse fails — with **fewer frames**
     (`selectRetryFrames`: first + last + evenly-spaced middle, capped at
     `RETRY_FRAME_CAP = 8`) and a **stricter, compact prompt** (`STRICT_SYSTEM`:
     JSON-only, overview ≤ 40 words, ≤ 3 best parts, ≤ 3 follow-ups) at a
     higher output cap (`RETRY_MAX_OUTPUT_TOKENS = 3072`).
  2. **Degrades to a minimal fallback `BriefingResult`** (HTTP 200, no `error`)
     when the retry also can't be parsed OR the retry call throws — so the UI
     renders a real briefing card (overview + "Try a smaller window" /
     "Pick the best parts for me" chips) instead of only an error bubble.
  3. **Hard error only** when the FIRST Gemini call fails or the request is
     invalid (unchanged).
  4. **Safe logging:** parse failures log the model text truncated to 300
     chars + its length via `console.warn`; never image/base64 or video bytes.
  - Extracted helpers: `selectRetryFrames`, `buildBriefingPrompt`,
    `parseBriefingJson`, `framesToImages`, `fallbackBriefing`, and two log
    helpers. No UI, ffmpeg/render/scoring, or Phase 5 changes. Video privacy
    unchanged — only the already-sampled frames are sent; no new upload path.
- **Files affected:** `app/api/agent/briefing/route.ts`, `memory/*`.
- **Reason:** Make the briefing resilient to incomplete/non-JSON Gemini output.
- **Validation:** `npm install` ✓, `npm run typecheck` ✓, `npm run build` ✓.
  CI (typecheck + build) will run on the PR. Browser/WebGPU + live-Gemini
  manual testing still required (no Gemini key / GPU in the build sandbox).

---

### 2026-06-11 — Add GitHub Actions CI + CHANGELOG formatting cleanup
- **Change made:**
  1. **CI workflow added** (`.github/workflows/ci.yml`). Runs on
     `pull_request` targeting `main` and on `push` to `main`: Ubuntu latest,
     Node 20 with npm cache, installs via `npm ci` (lockfile present, else
     `npm install`), then `npm run typecheck` and `npm run build`. Lint is
     intentionally NOT run — there is no ESLint config and `next lint` prompts
     interactively, which would hang CI. So future merges are gated on
     typecheck + build.
  2. **CHANGELOG formatting cleanup.** Restored two `###` headings that had
     been dropped by earlier chained edits (the "Structured briefing
     follow-ups + safe local-first actions" and "Editor syntax/typecheck fix"
     entries) and added the missing `---` separators, so each entry is again
     readable as a discrete dated block. No meaning changed.
- **Files affected:** `.github/workflows/ci.yml` (new), `memory/CHANGELOG.md`,
  `memory/PROJECT_STATE.md`, `memory/TODO.md`, `memory/CONSTRAINTS.md`.
- **Reason:** Production hygiene — automatically validate PRs, and keep the
  memory handoff brain clean for future agents.
- **Validation:** `npm install` ✓, `npm run typecheck` ✓, `npm run build` ✓
  (only the pre-existing `@huggingface/transformers` `import.meta` warning).
  CI workflow run status to be confirmed after the PR opens. Browser/WebGPU
  runtime still NOT verified — manual browser testing required.

---

### 2026-06-11 — Phase 4.5 sourceId polish + Phase 5 first hook extraction
- **Change made:**
  1. **Phase 4.5 polish — briefing `plan_topic` actions preserve `sourceId`.**
     When a briefing was created from one specific source in a multi-source
     project, clicking a topic chip could build a plan that ran across ALL
     selected sources. The client-side plan now passes
     `sources: [action.sourceId]` into `normalizePlan()` (which already
     sanitizes `sources`), so the run stays grounded on the source that was
     actually briefed. No `/api/agent` call; no genre/category logic. When a
     follow-up has no `sourceId`, behavior is unchanged. The `plan.created`
     activity log now records the locked `sources`.
  2. **Phase 5 (first extraction) — `hooks/useBriefingActions.ts`.** Moved the
     deterministic briefing follow-up handler (`promote` / `plan_topic` /
     `extract_range`, plus their logging + status/progress updates) out of the
     ~2000-line `app/editor/page.tsx` into one focused, behavior-identical
     hook. The page now calls `useBriefingActions({...})` and supplies the
     store setters/loggers it owns; the hook reuses the same store actions
     (`promoteBriefingParts`, `buildExtractedHighlight`, `normalizePlan`,
     `mergeHighlights`/`setHighlights`, `setPlan`/`setMode`/
     `setPendingExecution`/`setPendingClarify`). `chat` follow-ups still route
     through the normal chat pipe in `AssistantPanel`. No behavior change.
- **Files affected:** `hooks/useBriefingActions.ts` (new),
  `app/editor/page.tsx` (replaced the inline `handleBriefingAction` with the
  hook call; dropped now-unused `normalizePlan` / `SIGNAL_DEFAULTS` /
  `BriefingFollowUp` imports), `memory/*`.
- **Reason:** Keep multi-source briefings grounded (correctness), and begin
  Phase 5 maintainability with ONE low-risk, behavior-preserving extraction
  (no big refactor, no feature mixing).
- **Validation:** `npm install` ✓, `npm run typecheck` ✓, `npm run build` ✓
  (only the pre-existing `@huggingface/transformers` `import.meta` warning;
  `/editor` bundle unchanged at ~47.8 kB). `npm run lint` still NOT configured
  (`next lint` prompts for interactive setup). Browser/WebGPU runtime and the
  multi-source manual checks (plan locked to `sources:[briefingSourceId]`,
  Run analysis uses the intended source) still need a real browser. No CI run.

---

### 2026-06-11 — Structured briefing follow-ups + safe local-first actions
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

---

### 2026-06-11 — Editor syntax/typecheck fix
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

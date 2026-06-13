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

### 2026-06-13 — Agentic clarify: interpret imperfect prompts, kill the static topic question
- **Change made:** The planner no longer dead-ends on the static
  "I need a bit more before I can run the analysis — what should the short be
  about?" when the user already gave usable intent.
  1. **Planner prompt** (`lib/plan/prompt.ts`): added a step-0 "interpret
     imperfect/short prompts FIRST" rule to the clarify checklist. Broken
     grammar is read, not rejected. A content focus, a duration
     ("1min"/"1 min"/"one minute" → 60s + `userSpecifiedDuration`), or a scope
     word ("only"/"alone"/"just") makes a turn actionable → emit plan/moment,
     never a topic clarify. "only X" builds scenarios around X and pushes
     everything else into `avoid`. Includes the worked "ingredient part alone
     for 1min" example + the no-video upload-first message guidance.
  2. **Deterministic safety net** (`lib/plan/deriveIntent.ts`, NEW):
     `deriveActionableIntent(userText, ctx)` parses duration, content focus,
     `only/alone` exclusivity, generic exclusions, and format; plus
     `actionableIntentMessage(intent, hasVideo)` builds the dynamic reply
     ("Got it — I'll look for ingredient-only moments and build a 60s short…"
     / "Upload the video first, then I'll find the ingredient-only parts…").
  3. **Agent route** (`app/api/agent/route.ts`): the plan/moment-fail branch
     AND the direct `clarify` branch now consult `deriveActionableIntent`
     before asking anything — when actionable they synthesize a grounded plan
     (duration + focus + exclusions + format applied) and PROCEED. The old
     static string is removed; the remaining dead-end uses a context-aware
     `dynamicClarifyMessage(body)` (upload-first when no source).
     `synthesizeVaguePlan` gained an `intent?` param to apply the parsed
     duration/focus/avoid/format. New `hasVideoSource(body)` helper.
- **Files affected:** `lib/plan/prompt.ts`, `lib/plan/deriveIntent.ts` (new),
  `app/api/agent/route.ts`.
- **Reason:** "i need a ingredient part alone for 1min" carries focus +
  duration + scope; re-asking the topic read as broken. Prefer action over
  questions; ask at most one context-aware question only when a required
  decision is genuinely missing. Cloud provider routing (OpenRouter/Gemini/
  custom) unchanged; no WebLLM. Verified `npm run typecheck` (pass) + spot-
  checked the duration/focus parser on the spec's example prompts.

### 2026-06-13 — Tighten OpenRouter max_tokens (tiered caps) + RE-APPLY transient retry
- **Change made:**
  1. **Tiered max_tokens safety caps** replace the single 4096 default.
     `lib/config.ts` OPENROUTER now has `plannerMaxTokens: 1200`,
     `visionMaxTokens: 1600`, and an absolute `hardMaxTokens: 2048` ceiling.
     `lib/providers/openrouter.ts` adds `hardMaxTokens()` (env
     `OPENROUTER_MAX_TOKENS` → config ceiling) and `clampMaxTokens()`;
     `attemptCompletion` ALWAYS clamps the final `max_tokens` to the ceiling,
     so a giant value (e.g. the model's 65535 window) can NEVER be sent —
     even the briefing's 3072 retry is clamped to 2048. `openrouterJson`
     defaults to the planner cap, `openrouterMultiImageJson` to the vision cap
     (via internal `fallbackMaxTokens`).
  2. **Re-applied the transient-retry-with-backoff** that was lost: PR #48
     merged at commit 76080a8 (token cap only); the retry commit (bc09dbe)
     was pushed to that branch AFTER the merge and never landed on main.
     `createCompletion` is again split into a retry loop + `attemptCompletion`
     with `isRetryableError` (429/5xx/overload/network) + `sleep`, governed by
     `OPENROUTER.retryAttempts` (3) / `retryBaseDelayMs` (600). Non-transient
     errors (400/401/402/403) and aborted requests are NOT retried.
- **Files affected:** `lib/config.ts`, `lib/providers/openrouter.ts`,
  `lib/env.ts`, `.env.example`.
- **Reason:** Harden against the 402 "requested up to 65535 tokens, but can
  only afford 16000" error with a guaranteed hard clamp (the previous 4096
  default was not a hard ceiling and vision callers could exceed it), and
  restore the transient-overload retry that is the intended primary fix for
  the temporary "vision model is temporarily overloaded" issue. Verified with
  `npm run typecheck` (pass). No test runner exists in the repo.

### 2026-06-13 — Fix OpenRouter 402 "requires more credits, or fewer max_tokens" on the planner
- **Change made:** OpenRouter calls now send a default `max_tokens` cap when
  the caller doesn't pass one. Added `OPENROUTER.maxTokens` (default **4096**)
  in `lib/config.ts`, a `OPENROUTER_MAX_TOKENS` env override (`lib/env.ts` +
  documented in `.env.example`), and a `defaultMaxTokens()` resolver in
  `lib/providers/openrouter.ts` that `createCompletion` falls back to.
- **Files affected:** `lib/config.ts`, `lib/env.ts`,
  `lib/providers/openrouter.ts`, `.env.example`.
- **Reason:** The planner (`cloudPlannerJson` → `openrouterJson`) never set
  `max_tokens`. When omitted, OpenRouter PRE-RESERVES credits for the model's
  full completion window (65535 tokens for the configured model), so
  low-credit accounts were rejected with **HTTP 402** before the request ran
  (*"requires more credits, or fewer max_tokens … requested up to 65535 …
  can only afford 16000"*). The planner emits a small JSON plan, so a 4096
  cap keeps the reserved budget affordable. Vision callers (e.g. briefing)
  pass their own larger `maxTokens`, which still wins. Verified with
  `npm install` + `npm run typecheck` (pass).

### 2026-06-11 — Document OpenRouter-only pin (single model: openai/gpt-5.5-pro)
- **Change made (config/docs only, no code logic change):** `.env.example`
  now documents a "pin everything to OpenRouter + one model" setup:
  `CLOUD_PROVIDER_ORDER=openrouter` and all four model slugs
  (`OPENROUTER_DEFAULT_MODEL` / `CHEAP` / `PREMIUM` / `OSS`) set to
  `openai/gpt-5.5-pro`. Added a note: this is for OpenRouter pinned to one
  model with NO fallback. Comments show how to revert to the multi-provider
  default (blank `CLOUD_PROVIDER_ORDER`, mixed model slugs).
- **No code changes needed:** the dispatcher already supports this via env.
  `configuredOrder()` parses `CLOUD_PROVIDER_ORDER` → `["openrouter"]`;
  `providerOrder()` filters out gemini/groq; with a single provider
  `attemptableOrder` returns `["openrouter"]`, so `cloudPlannerJson` /
  `cloudVisionJson` try ONLY OpenRouter and rethrow on failure — **no
  Gemini/Groq fallback**. All routes call the dispatcher with no model
  override, so they use `OPENROUTER_DEFAULT_MODEL` (= `openai/gpt-5.5-pro`).
- **Exact env the user sets OUTSIDE the repo** (.env.local / Vercel):
  `OPENROUTER_API_KEY=<secret>`, `CLOUD_PROVIDER_ORDER=openrouter`,
  `OPENROUTER_DEFAULT_MODEL=openai/gpt-5.5-pro` (+ CHEAP/PREMIUM/OSS same).
- **Security (verified):** `OPENROUTER_API_KEY` is read server-side only
  (`lib/env.ts`); there is NO `NEXT_PUBLIC_OPENROUTER_API_KEY`; the key is
  not in `.env.example`, the client bundle, or logs; providers never log
  prompts/base64 frames/keys; no browser WebLLM. Lib config defaults left
  unchanged (multi-provider) so only this deployment's env pins it.
- **Caveat:** this pins chat/planning (and vision IF `openai/gpt-5.5-pro` is
  multimodal on OpenRouter). It does NOT change transcription — Whisper still
  runs locally in-browser; no cloud transcription provider was added.
- **Files affected:** `.env.example`; `memory/*`.
- **Validation:** `npm run typecheck` ✓, `npm run build` ✓.

---

### 2026-06-11 — Self-healing IndexedDB (fix "object store was not found" crash)
- **Root cause:** Two issues produced `NotFoundError: Failed to execute
  'transaction' on 'IDBDatabase': One of the specified object stores was not
  found.` (1) **DB-name collision** — `lib/audio/cache.ts` opened
  `createStore("shorts-studio-cache", "transcripts")` while `lib/store/idb.ts`
  opened the same DB name with store `"kv"`; idb-keyval only ever creates the
  FIRST object store a DB sees, so whichever opened second crashed. (2)
  **Stale/partial DBs** (old builds, failed upgrades, dev hot-reloads) where a
  DB exists without the expected `kv` store. Both surfaced as a red
  "Something went wrong" bubble.
- **Fix:** Rewrote `lib/store/idb.ts` as a self-healing layer:
    - Each logical store has its OWN database (one object store per DB):
      `sessions` → `shorts-studio-sessions/kv`, `cache` →
      `shorts-studio-cache/kv`, `logs` → `shorts-studio-logs/kv`,
      `transcripts` → **`shorts-studio-transcripts/kv`** (NEW dedicated DB —
      removes the collision). `lib/audio/cache.ts` now uses it.
    - Lazy store creation (`stores` map). `withIdbRecovery(kind, op, fn)`
      runs the op; on a missing-object-store error it DROPS the cached
      (broken) store handle, deletes ONLY that database (`deleteDatabaseSafe`,
      waits for real completion with a 2s safety timeout), recreates the
      store fresh, and retries the op exactly once.
    - Helpers: `isMissingObjectStoreError`, `deleteDatabaseSafe`,
      `safeGet/safeSet/safeDel/safeKeys/safeUpdate`, `resetAllLocalDatabases`
      (emergency dev util), and `friendlyStorageError` →
      `STORAGE_CORRUPTED_MESSAGE`.
    - The public `idbSessions` / `idbCache` / `idbLog` API shape is UNCHANGED
      (now backed by the safe helpers), so `sessions.ts`, `cache.ts`, and
      `log/store.ts` needed no edits.
    - Editor + launch error sites now map a persistent storage-corruption
      error to the clean message "Local browser storage was corrupted. Please
      clear site data and reload." instead of the raw IDB exception.
- **Scope/safety:** Only the AFFECTED DB is deleted (not all storage); video/
  source state is untouched; recovery only `console.warn`s the DB name +
  operation — never logs stored values, video bytes, base64 frames, prompts,
  API keys, or transcript text.
- **Emergency snippet (documented for support):**
  `["shorts-studio-sessions","shorts-studio-cache","shorts-studio-logs","shorts-studio-transcripts"].forEach(n=>indexedDB.deleteDatabase(n)); location.reload();`
- **Files affected:** `lib/store/idb.ts`, `lib/audio/cache.ts`,
  `app/editor/page.tsx`, `app/launch/page.tsx`; `memory/*`.
- **Validation:** `npm run typecheck` ✓, `npm run build` ✓. Browser
  corruption test still pending (no browser in sandbox).

---

### 2026-06-11 — Dynamic duration: removed forced/default 30s (explicit-only)
- **Change made:** Final clip length is now **explicit-only**. When the user
  does NOT name a duration, the app does not force or display 30s — selection
  runs the quality-floor path and total length is **emergent** from clip
  quality. When the user names a duration ("30 second reel", "make it 15s",
  "1 minute highlight"), `userSpecifiedDuration=true` + `targetShortSeconds`
  is parsed and the budgeted fit/trim runs. The pipeline already branched on
  `userSpecifiedDuration` (highlights.ts quality-floor vs budgeted;
  mergeAcrossSources skips budget when false) — this change removes the
  remaining places that *forced/showed* 30s when the user hadn't asked:
    - `lib/plan/prompt.ts` — D1 rewritten: "NEVER ASSUME 30 SECONDS";
      platform words (TikTok / YouTube Short / Instagram) imply FORMAT
      (vertical) only, never a duration; added parse examples (15s→15,
      "1 minute"→60, 1m30s→90, 0:45→45) and the "make it tighter" rule;
      removed the anti-loop example that forced `targetShortSeconds:30` + the
      "30s action reel" message; clarify chip "Make a 30s highlight reel" →
      "Make a highlight reel"; good-message exemplar no longer says "30s";
      promote `targetSeconds` documented as explicit-only; the rendered
      "Current plan" line now says `target=flexible (no user-set duration)`
      unless the user set one.
    - `app/api/agent/briefing/route.ts` — the vision SYSTEM prompt now tells
      the model NOT to bake a duration into follow-up chips ("no 30s/15s
      reel") unless asked; the no-follow-ups fallback is "Make a highlight
      reel of these moments".
    - `components/PlanPreview.tsx` — shows `{target}s` only when the user set
      a duration, else "flexible length".
    - `components/AssistantPanel.tsx` — starter chip "Make a 30s vertical
      reel" → "Make a vertical reel".
    - `app/editor/page.tsx` — the `plan.created` activity-log summary shows
      "flexible length" instead of "30s" for no-duration plans.
    - `hooks/useEditorStore.ts` — `memoryFromPlan` only persists
      `memory.duration` when `userSpecifiedDuration` is true, so the soft
      fallback (30) can no longer resurface as a phantom "30s preference" in
      the planner's memory block on later turns.
    - `lib/config.ts` — `PLAN_DEFAULTS.targetShortSeconds` (30) commented as a
      SOFT, NON-ENFORCED fallback only.
- **Promote/briefing:** "clip those" / "use these moments" / "make a reel
  from these" carry NO `targetSeconds` (natural clip lengths preserved);
  "make a 15s reel of these" sets `targetSeconds=15`. No default `30`.
- **OpenRouter setup verified unchanged + server-only:** `OPENROUTER_API_KEY`
  read only in `lib/env.ts` (no `NEXT_PUBLIC_OPENROUTER_API_KEY`),
  `OPENROUTER_DEFAULT_MODEL` defaults `google/gemini-2.5-flash`,
  `CLOUD_PROVIDER_ORDER` server-only toggle works, order OpenRouter → Gemini →
  Groq, vision excludes Groq, PR #43 circuit fallback intact, no browser
  WebLLM, no key/prompt/base64 logging.
- **Files affected:** `lib/plan/prompt.ts`, `lib/config.ts`,
  `app/api/agent/briefing/route.ts`, `components/PlanPreview.tsx`,
  `components/AssistantPanel.tsx`, `app/editor/page.tsx`,
  `hooks/useEditorStore.ts`; `memory/*`.
- **Reason:** A no-duration request should produce a natural-length reel
  driven by footage quality, not a forced 30s. Explicit durations still fit.
- **Validation:** `npm run typecheck` ✓, `npm run build` ✓.

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

### 2026-06-11 — Fix: provider circuit-open no longer blocks Gemini/Groq fallback
- **Change made:** The route-level circuit pre-check could 503 a request when
  the **primary** provider's circuit was open — before the dispatcher could
  try the fallbacks. Fixed so the dispatcher owns circuit handling:
  - `lib/ratelimit/index.ts` — Layer 4 (provider circuit breaker) is now
    **opt-in**: it only runs (and can block) when a caller passes an explicit
    `provider`. Dispatcher-backed routes omit it. Session (Layer 2) + global
    budget (Layer 3) checks are unchanged and still apply.
  - `lib/providers/cloud.ts` — new `attemptableOrder()` filters
    `CLOUD_PROVIDER_ORDER` by circuit state: **skips circuit-open providers**
    and tries the next configured one; if EVERY provider's circuit is open it
    falls back to the full configured order (best-effort, self-healing).
    `cloudPlannerJson` / `cloudVisionJson` use it; success/failure is still
    recorded per **actual** provider attempted.
  - `app/api/agent/route.ts`, `app/api/agent/briefing/route.ts`,
    `app/api/vision/clip/route.ts` — dropped the `provider: primaryProvider()`
    arg from `checkAllLimits` (+ removed the now-unused import) so an open
    primary circuit can't 503 before fallback.
  - `app/api/vision/frame` + `/api/vision/window` (Gemini-direct, single
    provider, no fallback) keep passing `provider: "gemini"` → their fast-fail
    behaviour is unchanged.
- **Result:** With OpenRouter primary + Gemini/Groq configured, an OpenRouter
  outage/open-circuit now falls back (text → Gemini → Groq; vision → Gemini)
  instead of returning 503. Groq stays text-only (excluded from vision).
- **Files affected:** `lib/ratelimit/index.ts`, `lib/providers/cloud.ts`,
  `app/api/agent/route.ts`, `app/api/agent/briefing/route.ts`,
  `app/api/vision/clip/route.ts`; `memory/*`.
- **Reason:** A circuit breaker on the primary should reroute to a healthy
  fallback, not fail the whole request.
- **Validation:** `npm install` ✓, `npm run typecheck` ✓, `npm run build` ✓.
  No browser WebLLM reintroduced; keys still server-only; no prompt/base64/key
  logging. Live forced-failure fallback test pending (no API keys in sandbox).

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

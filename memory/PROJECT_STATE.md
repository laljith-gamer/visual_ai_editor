# PROJECT STATE — Source of Truth

> This file is **authoritative**. When in doubt, trust this file (and the
> code) over any other memory file. Keep it current: update it whenever the
> status, architecture, or "next best step" changes.
>
> Last updated: 2026-06-11 (dynamic duration — removed forced/default 30s; explicit-only)

---

## 1. Project name

**Shorts Studio** (`shorts-studio`) — Universal Video Shorts Editor.

## 2. Main goal

Turn long videos into platform-ready short clips **through conversation**.
Browser-first and free-tier friendly: the heavy work (frame sampling,
scoring, rendering) runs **on-device**, and **video bytes never leave the
browser**. The server is only a thin authenticated proxy for LLM
text/JSON calls.

## 3. Current status

- Version: **1.7.9** (see `package.json`).
- Latest validation: `npm install` + `npm run typecheck` + `npm run build`
  all pass. (`npm run lint` is not separately configured — `next lint`
  prompts for interactive setup; the build runs its own type/lint pass.)
- **CI (GitHub Actions) is now in place** — `.github/workflows/ci.yml` runs
  `npm run typecheck` + `npm run build` on every PR to `main` and every push
  to `main` (Ubuntu, Node 20, npm cache). Lint is intentionally excluded
  (no ESLint config; `next lint` is interactive). **Browser/WebGPU runtime
  verification is still manual and still required** — CI cannot exercise it.
- Core conversational editing pipeline is working: plan → sample → score →
  detect windows → verify → assemble → render.
- Active line of work (2026-06-11): **removed the in-browser WebLLM
  local-first path** and moved language/tool routing **server-side to
  OpenRouter**, with Gemini/Groq kept as fallbacks. The app is **no longer
  offline / local-LLM**, and there is no in-browser model download.
- **Cloud model routing** goes through a provider dispatcher
  (`lib/providers/cloud.ts`) in the order **OpenRouter → Gemini → Groq**
  (`CLOUD_PROVIDER_ORDER`): the first provider with a configured key wins,
  a failure falls back to the next, and each provider's circuit breaker is
  recorded independently. Groq is text-only (skipped for vision). The
  dispatcher also **skips circuit-open providers** (`attemptableOrder`) and
  tries the next one — so an OpenRouter outage reroutes to Gemini/Groq rather
  than 503-ing. The route-level circuit pre-check (`checkAllLimits`) is
  **opt-in** (only the single-provider Gemini-direct routes pass `provider`);
  session + global-budget limits still apply to every route. The order can
  also be overridden/toggled at deploy time via the server-only
  `CLOUD_PROVIDER_ORDER` env var (e.g. `gemini` = Gemini only, `openrouter` =
  OpenRouter only); unset → the config default above.
    - `/api/agent` planner JSON uses `cloudPlannerJson`; `normalizePlan` and
      every mode (clarify/briefing/promote/extract/edit/merge/describe) are
      unchanged.
    - `/api/agent/briefing` + `/api/vision/clip` use `cloudVisionJson`
      (OpenRouter multimodal → direct Gemini). OpenRouter handles vision only
      when its configured model is multimodal (default
      `google/gemini-2.5-flash` is); otherwise it falls back to Gemini. No
      fake frame/caption/vision data. (`/api/vision/frame` + `/api/vision/window`
      still use Gemini direct — intentionally out of scope this change.)
- **Security:** the OpenRouter key is **server-only** (`OPENROUTER_API_KEY`,
  read in `lib/env.ts`); there is **no** `NEXT_PUBLIC_OPENROUTER_API_KEY`;
  the key name + endpoint are verified absent from the client bundle.
  Providers never log the key, prompts, or base64 frames. Full video bytes
  never leave the browser — only the already-sampled frames go to the cloud
  vision routes.
- **Deterministic, non-model client paths remain intact:** structured
  briefing follow-ups (`lib/briefing/followups.ts`,
  `hooks/useBriefingActions.ts`), the grammar quick-shortcut gate
  (`lib/intent/*`), and promote/extract/reset via the cloud planner's modes
  + their existing client handlers.
- **Structured briefing follow-ups are DONE (Phase 3).** Briefing chips now
  carry intent via a `BriefingFollowUp` union and run deterministically
  (promote/plan_topic/extract_range) or via chat — no more raw-text
  round-trip to the planner and no "what should the short be about?" loop.
  Multi-source safe: a `plan_topic` chip locks its plan to the briefing's
  `sourceId` so the run stays on the source that was briefed.
- **Phase 5 has STARTED (one extraction only).** The briefing follow-up
  handler now lives in `hooks/useBriefingActions.ts` (behavior-identical);
  `app/editor/page.tsx` calls it. The remaining hook extractions
  (`useAgentPlanner` / `useTimelineCommandRunner` / `usePipelineRunner` /
  `useAssistantController`) are NOT done — do them one at a time, only when
  touching related code.
- **Still library-only / not wired:** `lib/vision-core/`, `lib/frame-tree/`,
  `lib/vision/caption*`. These need REAL sampled/captioned frame data before
  the local router should execute `plan`/`describe` locally (deliberately
  deferred — see Next best step).
- **Briefing endpoint is resilient to bad JSON (2026-06-11).**
  `/api/agent/briefing` now retries ONCE with fewer frames + a stricter
  compact prompt when the first Gemini response can't be parsed, and falls
  back to a minimal 200 `BriefingResult` (overview + "Try a smaller window" /
  "Pick the best parts for me" chips) if the retry also fails — so
  "Describe what's in this video" no longer dead-ends on *"The video summary
  came back incomplete…"*. A hard error is returned only when the first
  Gemini call fails or the request is invalid.
- **No open PRs blocking** at time of writing.

> Update this section as PRs merge and features ship.

## 4. Current architecture

High level:

```
Upload video (stays in the browser)
  → User chats: "make a 30s reel of the best moments"
  → Planner (server → OpenRouter → Gemini → Groq) returns a structured EditPlan
  → Browser samples frames (mediabunny) + computes motion/saliency
  → Scores frames (SigLIP via WebGPU; motion+saliency when semantic=0)
  → Groups high-score frames into candidate windows
  → Verifies windows via a contact-sheet image (server → Gemini keep/skip)
  → Assembles highlights → renders MP4 (ffmpeg.wasm in a Web Worker)
  → Preview / share / download
```

- **Framework:** Next.js 15 (App Router) + React 19 + TypeScript.
- **In-browser AI:** `@huggingface/transformers` (SigLIP, Whisper) on WebGPU.
- **Rendering:** `@ffmpeg/ffmpeg` (wasm) in a worker.
- **Server routes:** `app/api/*` — auth (iron-session) + 4-layer rate limit;
  proxy LLM calls only (OpenRouter → Gemini → Groq via
  `lib/providers/cloud.ts`). No video upload.
- **State:** Zustand store (`hooks/useEditorStore.ts`); IndexedDB for
  sessions/cache/logs (never blobs).

### Local-first modules (status as of 2026-06-11)

| Module | Purpose | Status |
|--------|---------|--------|
| `lib/providers/openrouter.ts` + `lib/providers/cloud.ts` | Server-side OpenRouter client + provider-order dispatcher (OpenRouter → Gemini → Groq) for language/tool routing + vision | **LIVE (server-side)** |
| `lib/llm/` (WebLLM engine/chat/tools/grounding) + `localFirst.ts` | Browser WebLLM language + tool router | **REMOVED (2026-06-11)** — replaced by server-side OpenRouter |
| `lib/briefing/followups.ts` | Pure normalizer: legacy/string briefing follow-ups → structured `BriefingFollowUp` actions | **LIVE** |
| `hooks/useBriefingActions.ts` | Phase 5 extraction: deterministic briefing follow-up handler (promote/plan_topic/extract_range) pulled out of `app/editor/page.tsx`, behavior-identical | **LIVE** |
| `lib/vision-core/` | Offline deterministic reasoning engine (segments, scoring, sentiment) | **MERGED to main**; not wired |
| `lib/frame-tree/` | In-browser frame organization tree (frames→shots→scenes→chapters) | **MERGED to main** (#29); not wired |
| `lib/vision/caption*` | Optional in-browser frame captioning (Florence-2 / ViT-GPT2) | **MERGED to main** (#30); not wired |
| `lib/pipeline/temporal.ts` range fix | Contact-sheet verification was dead for non-opening windows | **MERGED to main** (#28) |
| `app/api/agent/route.ts` briefing fallback | Briefing follow-up chips no longer hit generic clarify | **MERGED to main** (#33 + clarify-guard follow-up) |

> "Wired into UI" = an end-to-end path in the assistant panel actually
> calls these. The browser WebLLM layer was **removed**; language/tool
> routing is now **server-side** (OpenRouter → Gemini → Groq via
> `lib/providers/cloud.ts`). `vision-core` / `frame-tree` / captioning
> remain library-only until real frame data feeds them.

## 5. Important files / folders

- `app/api/agent/route.ts` — main planner endpoint (intent → mode dispatch).
- `app/api/agent/briefing/route.ts` — whole-video briefing.
- `lib/plan/prompt.ts` — planner system prompt + user-prompt builder.
- `lib/plan/normalize.ts` — validates/normalizes LLM plans into `EditPlan`.
- `lib/pipeline/*` — sample, score, events, temporal, highlights, render.
- `lib/vision/*` — SigLIP worker, contact sheet, (new) captioning.
- `lib/providers/*` — OpenRouter + Gemini + Groq clients, plus the
  `cloud.ts` provider-order dispatcher (the single place provider preference
  is decided).
- `lib/config.ts` — all tunable constants + CSP.
- `lib/types.ts` — central domain types (`EditPlan`, `AgentResponse`, etc.).
- `hooks/useEditorStore.ts` — client source of truth (Zustand).
- `components/*` — editor UI (timeline, drawers, assistant panel).

## 6. Current problems / known issues

> Keep this list honest and current. Remove items when fixed.

- The deeper local-first modules (`lib/vision-core/`, `lib/frame-tree/`,
  `lib/vision/caption*`) are **merged but not wired** — they were built to
  ground a local router that has since been **removed**. They remain
  available for future use (e.g. enriching the server planner with
  client-computed frame context) but are not on any live path. Do not fake
  frame data to wire them.
- **Deploy lag:** fixes merged to `main` (e.g. the briefing "invalid JSON"
  fix) won't appear in the running app until it is rebuilt/redeployed.
- **Runtime verification gap:** WebGPU features (SigLIP / Whisper /
  captioning) and live OpenRouter/Gemini calls cannot be verified in a
  headless/CI sandbox — they need a real browser + GPU and real API keys.
  Typecheck + unit-level checks only go so far.
- Sandbox/CI may have **no `node_modules` by default** — run `npm install`
  before trusting a typecheck (otherwise bare-import type errors are hidden).

## 7. Next best step

- **Validate OpenRouter end-to-end in a real deployment.** Set
  `OPENROUTER_API_KEY` and confirm: `/api/agent` returns valid planner JSON;
  "Describe what's in this video" works via OpenRouter multimodal (default
  `google/gemini-2.5-flash`); structured briefing chips +
  promote/extract/reset still work; and with the key unset (or on a forced
  failure) the flow falls back to direct Gemini/Groq. Confirm in the browser
  Network tab that there is no model download and the key never appears
  client-side.
- **Optional: extend OpenRouter to the remaining vision routes.**
  `/api/vision/frame` + `/api/vision/window` still call Gemini directly; they
  could route through `cloudVisionJson` for consistency (intentionally left
  out of this change to keep scope tight).
- **Optional: enrich the server planner with client frame context.** Now that
  routing is server-side, `lib/frame-tree/` + `lib/vision/caption*` outputs
  could be summarised and passed into the planner prompt (text only, never
  fake) to improve grounding — a future enhancement, not required.
- **Phase 5 (maintainability, IN PROGRESS — 1 of ~5 done):**
  `app/editor/page.tsx` is large. First extraction shipped:
  `hooks/useBriefingActions.ts`. Continue ONE hook at a time, only when
  touching related code and strictly behavior-identical — next candidates:
  `useAgentPlanner`, `useTimelineCommandRunner`, `usePipelineRunner`,
  `useAssistantController`. Do not mix with feature work; no big rewrite.
- **Browser/GPU + live-API verification** of the cloud chat/vision path and
  the on-device SigLIP/Whisper/captioning features is still pending — needs a
  real WebGPU browser and real API keys; the sandbox has neither.

> Replace this with the actual next step whenever it changes.

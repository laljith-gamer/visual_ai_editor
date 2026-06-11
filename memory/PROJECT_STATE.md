# PROJECT STATE — Source of Truth

> This file is **authoritative**. When in doubt, trust this file (and the
> code) over any other memory file. Keep it current: update it whenever the
> status, architecture, or "next best step" changes.
>
> Last updated: 2026-06-11 (Phase 4.5 sourceId polish + Phase 5 first hook extraction)

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
- Core conversational editing pipeline is working: plan → sample → score →
  detect windows → verify → assemble → render.
- Active line of work: **making the client local-first** (offline reasoning
  + local LLM + frame organization), with cloud Gemini becoming optional
  rather than required.
- **Local-first is PARTIALLY WIRED into the live assistant UI** behind the
  `NEXT_PUBLIC_LOCAL_FIRST_EDITOR` flag (default OFF):
    - **Phase 4 v1 (on main):** `lib/llm/localFirst.ts` runs the model-driven
      router (`routeTurn`) on-device before the cloud planner and answers
      `chat` turns locally with grounding.
    - **Phase 4.5 (this change):** the local path now also EXECUTES a closed
      set of safe deterministic actions on-device — `promote`, `extract`,
      `reset` — each mapping onto an existing tested store path. Everything
      else (`plan`/`moment`/`edit`/`merge`/`describe`), low confidence, or
      missing data FALLS THROUGH to the unchanged cloud planner. No faked
      frame-tree/vision data.
    - With the flag OFF or on any fall-through, the existing Gemini/Groq
      flow is byte-for-byte unchanged.
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
- **No open PRs blocking** at time of writing.

> Update this section as PRs merge and features ship.

## 4. Current architecture

High level:

```
Upload video (stays in the browser)
  → User chats: "make a 30s reel of the best moments"
  → Planner (server → Gemini, Groq fallback) returns a structured EditPlan
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
  proxy LLM calls only. No video upload.
- **State:** Zustand store (`hooks/useEditorStore.ts`); IndexedDB for
  sessions/cache/logs (never blobs).

### Local-first modules (status as of 2026-06-11)

| Module | Purpose | Status |
|--------|---------|--------|
| `lib/llm/` (engine, chat, tools, grounding) | Local WebLLM engine + streaming chat + model-driven tool router (replaces keyword intent) + briefing "why" grounding | **MERGED + WIRED** behind flag via `lib/llm/localFirst.ts` |
| `lib/llm/localFirst.ts` | Flag-gated live entry: routes a turn locally, answers `chat`, and EXECUTES safe `promote`/`extract`/`reset` actions; falls through to cloud otherwise | **LIVE (flag default OFF)** |
| `lib/briefing/followups.ts` | Pure normalizer: legacy/string briefing follow-ups → structured `BriefingFollowUp` actions | **LIVE** |
| `hooks/useBriefingActions.ts` | Phase 5 extraction: deterministic briefing follow-up handler (promote/plan_topic/extract_range) pulled out of `app/editor/page.tsx`, behavior-identical | **LIVE** |
| `lib/vision-core/` | Offline deterministic reasoning engine (segments, scoring, sentiment) | **MERGED to main**; not wired |
| `lib/frame-tree/` | In-browser frame organization tree (frames→shots→scenes→chapters) | **MERGED to main** (#29); not wired |
| `lib/vision/caption*` | Optional in-browser frame captioning (Florence-2 / ViT-GPT2) | **MERGED to main** (#30); not wired |
| `lib/pipeline/temporal.ts` range fix | Contact-sheet verification was dead for non-opening windows | **MERGED to main** (#28) |
| `app/api/agent/route.ts` briefing fallback | Briefing follow-up chips no longer hit generic clarify | **MERGED to main** (#33 + clarify-guard follow-up) |

> "Wired into UI" = an end-to-end path in the assistant panel actually
> calls these. `lib/llm/` is now wired behind `NEXT_PUBLIC_LOCAL_FIRST_EDITOR`
> for chat + the safe deterministic actions; `vision-core` / `frame-tree` /
> captioning remain library-only until real frame data feeds them. The
> existing cloud (Gemini/Groq) flow is unchanged when the flag is off or the
> local path falls through.

## 5. Important files / folders

- `app/api/agent/route.ts` — main planner endpoint (intent → mode dispatch).
- `app/api/agent/briefing/route.ts` — whole-video briefing.
- `lib/plan/prompt.ts` — planner system prompt + user-prompt builder.
- `lib/plan/normalize.ts` — validates/normalizes LLM plans into `EditPlan`.
- `lib/pipeline/*` — sample, score, events, temporal, highlights, render.
- `lib/vision/*` — SigLIP worker, contact sheet, (new) captioning.
- `lib/providers/*` — Gemini + Groq clients.
- `lib/config.ts` — all tunable constants + CSP.
- `lib/types.ts` — central domain types (`EditPlan`, `AgentResponse`, etc.).
- `hooks/useEditorStore.ts` — client source of truth (Zustand).
- `components/*` — editor UI (timeline, drawers, assistant panel).

## 6. Current problems / known issues

> Keep this list honest and current. Remove items when fixed.

- The deeper local-first modules (`lib/vision-core/`, `lib/frame-tree/`,
  `lib/vision/caption*`) are **merged but not wired** — the local router
  still defers `plan`/`moment`/`describe` to the cloud because executing
  them locally requires REAL sampled/captioned frame-tree data that isn't
  fed in yet. Do not fake that data.
- **Deploy lag:** fixes merged to `main` (e.g. the briefing "invalid JSON"
  fix) won't appear in the running app until it is rebuilt/redeployed.
- **Runtime verification gap:** WebGPU features (SigLIP/Whisper/WebLLM/
  captioning) cannot be verified in a headless/CI sandbox — they need a real
  browser + GPU. Typecheck + unit-level checks only go so far.
- Sandbox/CI may have **no `node_modules` by default** — run `npm install`
  before trusting a typecheck (otherwise bare-import type errors are hidden).

## 7. Next best step

- **Feed REAL frame data into local `plan`/`describe`.** The remaining
  local-first win is letting the on-device router execute `plan`/`moment`/
  `describe` using `lib/frame-tree/` + `lib/vision/caption*` outputs (and
  `lib/vision-core/` scoring) instead of deferring to the cloud. This is
  gated on building the sampled/captioned frame-tree for the active source
  and passing its outline into `routeTurn`/grounding. Never fake it — until
  the tree is real, these stay cloud-owned.
- **Extend safe local actions to `edit`.** `promote`/`extract`/`reset` now
  run locally; `edit` (trim/drop/split) is the next deterministic candidate
  — map `ToolDecision.operation` onto the existing `EditOperation` store
  actions, behind the same flag + confidence floor.
- **Phase 5 (maintainability, IN PROGRESS — 1 of ~5 done):**
  `app/editor/page.tsx` is large. First extraction shipped:
  `hooks/useBriefingActions.ts`. Continue ONE hook at a time, only when
  touching related code and strictly behavior-identical — next candidates:
  `useAgentPlanner`, `useTimelineCommandRunner`, `usePipelineRunner`,
  `useAssistantController`. Do not mix with feature work; do not do a big
  rewrite.
- **Browser/GPU verification** of the flag-ON path (local router executing
  promote/extract/reset, and local chat) is still pending — needs a real
  WebGPU browser; the sandbox has no GPU.

> Replace this with the actual next step whenever it changes.

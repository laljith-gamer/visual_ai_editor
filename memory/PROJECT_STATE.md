# PROJECT STATE — Source of Truth

> This file is **authoritative**. When in doubt, trust this file (and the
> code) over any other memory file. Keep it current: update it whenever the
> status, architecture, or "next best step" changes.
>
> Last updated: 2026-06-10 (clarify briefing guard + synth narrowing)

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
- Core conversational editing pipeline is working: plan → sample → score →
  detect windows → verify → assemble → render.
- Active line of work: **making the client local-first** (offline reasoning
  + local LLM + frame organization), with cloud Gemini becoming optional
  rather than required.
- **Merged to `main` (library layers — NOT yet wired into the chat UI):**
  the local WebLLM engine + the capable chat system (streaming chat,
  model-driven tool router that replaces keyword intent matching, briefing
  grounding), the deterministic reasoning engine (`lib/vision-core`),
  the frame-organization tree (`lib/frame-tree`), optional frame
  captioning (`lib/vision/caption*`), the temporal-pass range fix, and the
  briefing follow-up clarify fallback (PR #33, now merged + extended so the
  LLM's own `mode:"clarify"` also respects briefing context).
- **No open PRs blocking** at time of writing; next major step is the
  flag-gated local-first UI wiring (see Next best step).

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

### Local-first modules (status as of 2026-06-10)

| Module | Purpose | Status |
|--------|---------|--------|
| `lib/llm/` (engine, chat, tools, grounding) | Local WebLLM engine + streaming chat + model-driven tool router (replaces keyword intent) + briefing "why" grounding | **MERGED to main**; not wired into UI |
| `lib/vision-core/` | Offline deterministic reasoning engine (segments, scoring, sentiment) | **MERGED to main**; not wired |
| `lib/frame-tree/` | In-browser frame organization tree (frames→shots→scenes→chapters) | **MERGED to main** (#29); not wired |
| `lib/vision/caption*` | Optional in-browser frame captioning (Florence-2 / ViT-GPT2) | **MERGED to main** (#30); not wired |
| `lib/pipeline/temporal.ts` range fix | Contact-sheet verification was dead for non-opening windows | **MERGED to main** (#28) |
| `app/api/agent/route.ts` briefing fallback | Briefing follow-up chips no longer hit generic clarify; both the plan/moment branch AND the direct `mode:"clarify"` branch synthesize a single briefing-grounded scenario | **MERGED to main** (#33 + clarify-guard follow-up) |

> "Wired into UI" = an end-to-end path in the assistant panel actually
> calls these. None are wired yet — they are library layers behind no
> feature flag. The existing cloud (Gemini/Groq) flow is unchanged.

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

- Local-first modules are **not integrated into the chat UI yet** — the
  `lib/llm/` chat+tool system and `lib/vision-core/` are merged to `main`
  but no end-to-end path in the assistant panel calls them.
- **Deploy lag:** fixes merged to `main` (e.g. the briefing "invalid JSON"
  fix) won't appear in the running app until it is rebuilt/redeployed.
- **Runtime verification gap:** WebGPU features (SigLIP/Whisper/WebLLM/
  captioning) cannot be verified in a headless/CI sandbox — they need a real
  browser + GPU. Typecheck + unit-level checks only go so far.
- Sandbox/CI may have **no `node_modules` by default** — run `npm install`
  before trusting a typecheck (otherwise bare-import type errors are hidden).

## 7. Next best step

- **Wire the merged local-first chain into the UI**, behind a feature flag
  (`NEXT_PUBLIC_LOCAL_FIRST_EDITOR`) that defaults OFF so the existing
  Gemini flow is byte-for-byte unchanged. Pieces are on `main`
  (`lib/llm/` chat+tools+grounding, `lib/vision-core/`, `lib/frame-tree/`,
  `lib/vision/caption*`); what's missing is the assistant-panel integration:
    1. route a turn with `routeTurn()` (tool decision),
    2. execute the decision through existing editor actions,
    3. for `chat`/questions, stream a grounded answer via `streamChat()`,
    4. fall back to `/api/agent` on disabled/unsupported/low-confidence.
  This is THE production step that makes the capable system user-facing —
  until it lands, the live app still runs the old keyword→cloud path.
- **Structured briefing follow-ups** — replace `followUps: string[]` with a
  `BriefingFollowUp` action union so chips carry intent (promote/plan_topic/
  extract) and don't make the server re-guess from raw text.

> Replace this with the actual next step whenever it changes.

# PROJECT STATE — Source of Truth

> This file is **authoritative**. When in doubt, trust this file (and the
> code) over any other memory file. Keep it current: update it whenever the
> status, architecture, or "next best step" changes.
>
> Last updated: 2026-06-08

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
  rather than required. These pieces exist as **library modules on open PRs**
  and are **not yet wired into the live chat flow**.

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

### Local-first modules added this session (library code; wiring pending)

| Module | Purpose | Status |
|--------|---------|--------|
| `lib/vision-core/` | Offline deterministic reasoning engine (segments, scoring, sentiment) | On a PR; not wired |
| `lib/frame-tree/` | In-browser frame organization tree (frames→shots→scenes→chapters) | On a PR; not wired |
| `lib/vision/caption*` | Optional in-browser frame captioning (Florence-2 / ViT-GPT2) | On a PR; not wired |
| `lib/llm/` | Local WebLLM planner (WebGPU), Gemini optional | On a PR; not wired |

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

- Local-first modules are **not integrated** into the chat flow yet (no
  end-to-end path uses them).
- **Runtime verification gap:** WebGPU features (SigLIP/Whisper/WebLLM/
  captioning) cannot be verified in a headless/CI sandbox — they need a real
  browser + GPU. Typecheck + unit-level checks only go so far.
- Sandbox/CI may have **no `node_modules` by default** — run `npm install`
  before trusting a typecheck (otherwise bare-import type errors are hidden).

## 7. Next best step

- Decide the **integration approach** for the local-first chain
  (grammar shortcut → deterministic engine → local LLM → optional cloud)
  and wire it behind a **feature flag that defaults OFF** so the existing
  Gemini flow stays byte-for-byte unchanged.
- Before that, get the foundational PRs reviewed/merged so integration can
  be built cleanly on `main`.

> Replace this with the actual next step whenever it changes.

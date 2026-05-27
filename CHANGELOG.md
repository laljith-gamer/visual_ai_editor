# Changelog

All notable changes to Shorts Studio are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to semantic versioning.

## [1.1.0] — 2026-05-27

### Added
- **Conversational planner with three intent modes** — every chat turn
  is classified as `plan` (multi-clip reel), `moment` (single-scene
  retrieval), or `clarify` (ask before assuming). The full policy lives
  in `.kiro/steering/conversation-patterns.md`.
- **Multi-turn refinement.** Refinements like "make it shorter",
  "vertical please", or "add the saves" emit a `planPatch` that is
  merged into the current plan via `lib/plan/merge.ts`. The pipeline
  no longer restarts from scratch on each turn — predictions cache is
  reused when scenarios didn't change.
- **Inference-first defaults.** The planner now follows a strict
  hierarchy: user statement → session memory → context inference →
  clarify. Every inferred field is surfaced to the user in the chat as
  an "I assumed" badge they can override.
- **Moment-retrieval pipeline** (`lib/pipeline/moment.ts`) for
  "find the part where ___" queries. Reuses frame scoring then runs a
  bounded temporal pass on the top 3 candidates and returns exactly one
  precisely-edged clip. About 5× cheaper than the multi-clip path.
- **Quick-reply chips** for clarify questions, surfaced both in the
  chat panel and as starter suggestions when the chat is empty.
- **`ModeBadge`** in the topbar showing the current intent mode plus
  an "N inferred" pill that hovers to reveal each assumption.
- **Heuristic intent inference** (`lib/plan/intent.ts`): source
  aspect → format, source duration → target seconds, prompt keywords
  → pacing (sports / talking-head / default) and platform format hints
  (TikTok, Reel, YouTube Short, etc.).

### Changed
- **Every magic number now lives in `lib/config.ts`** — scoring
  weights, event-detection thresholds, contact-sheet dimensions, plan
  defaults and bounds, inference heuristic constants, render settings,
  cache size. Pipeline files import named constants only.
- `lib/plan/normalize.ts` no longer silently substitutes a fake
  `{ id: "highlight", prompt: "visually engaging moment" }` scenario
  when the LLM omitted scenarios. It now reports `missing: ["scenarios"]`
  and the agent route converts that into a clarify response.
- `app/api/agent/route.ts` now accepts `{ messages, currentPlan,
  videoMeta, memory }` and returns a discriminated
  `AgentResponse` union (`plan` | `moment` | `clarify` | `error`).
- The hardcoded greeting moved from the React tree into
  `GREETINGS.initial` in `lib/config.ts`.
- `useEditorStore` no longer auto-clears highlights between turns. The
  source video, plan, predictions cache, and highlights persist until
  the user explicitly hits "New chat" or removes the source.

### Steering
- New `.kiro/steering/conversation-patterns.md` documents the three
  modes, defaults policy, refinement rules, and the no-hardcode policy
  so future sessions inherit the same conventions.

## [1.0.0] — 2026-05-27

### Added
- Initial Next.js 15 + TypeScript rebuild. Replaces the previous
  Python (FastAPI + OpenCV + ffmpeg subprocess) stack with a single
  browser-first codebase.
- Conversational planner via Gemini 2.5 Flash (primary) and Groq
  Llama 3.3 70B (fallback) producing a strict JSON `EditPlan`.
- Two-phase visual pipeline:
  - Per-frame zero-shot scoring via SigLIP running locally in a Web
    Worker (`@huggingface/transformers`), with an optional cloud
    Gemini fallback for low-end devices.
  - Temporal "keep / skip" pass on candidate windows rendered as
    contact-sheet images and judged by Gemini.
- Highlight selection ported from the Python `build_highlights`,
  including bucketed selection across the timeline and length bonus.
- ffmpeg.wasm rendering in a dedicated Web Worker. Outputs vertical,
  horizontal, or square shorts with optional fade transitions.
- IndexedDB-backed sessions, history, memory chips and predictions
  cache (re-edits with a different prompt skip frame analysis).
- Iron-session signed cookie for stable per-device identity.
- Optional Upstash Redis rate limiting on every API route.
- PWA manifest + service worker → installable on iOS 18+ and Android.
- Responsive shell: 3-column desktop, 2-column tablet, 1-column mobile.
- Cross-Origin-Opener-Policy / Embedder-Policy headers required for
  SharedArrayBuffer (ffmpeg + transformers).

### Removed
- The entire Python backend (`backend/`, `processor.py`, `ai_planner.py`,
  FastAPI server, Roboflow workflow client).
- `vercel.json` rewrite-everything-to-`api/index.py` configuration.

### Notes
- Free-tier costs: $0/mo for the recommended provider stack at hobby
  scale. See `README.md` for the full breakdown.
- v1 ships with browser-only render; cloud render fallback for very
  long sources is deferred to v2.

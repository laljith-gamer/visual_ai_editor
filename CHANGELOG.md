# Changelog

All notable changes to Shorts Studio are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to semantic versioning.

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

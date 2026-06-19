# Shorts Studio

**Universal Video Shorts Editor** — turn long videos into platform-ready short clips through conversation. Browser-first, free-tier friendly, and designed so full video bytes stay on the user's device.

## What it does

1. Upload one or more videos into the browser editor.
2. Ask for an edit in chat, for example: `make a 40 sec reel of the best moments`, `add first 30 seconds`, `merge all videos`, or `combat from the first video and cutscene from the second`.
3. The assistant routes the request through deterministic editor commands, guided intake, quick shortcuts, or the structured planner.
4. For visual selection, the browser samples frames, scores them with local signals and optional model assistance, detects candidate windows, verifies temporal windows when available, and builds timeline clips.
5. The timeline can be edited, undone/redone, transitioned, rendered, previewed, and exported as MP4.

## Current architecture

```text
Browser
  Upload rail
    -> Zustand editor store
    -> Agent layers / planner response
    -> Frame sampling + scoring
    -> Candidate windows + temporal verification
    -> Highlight timeline + transitions
    -> Mediabunny/WebCodecs render
    -> ffmpeg.wasm fallback worker
    -> Preview / export

Server
  Next.js route handlers
    -> iron-session user session
    -> rate-limit / budget / circuit guards
    -> server-only cloud provider dispatcher
    -> structured JSON responses
```

### Privacy boundary

- Full uploaded videos stay in the browser.
- Runtime `Blob` objects and object URLs are not persisted by default.
- Project restore persists source manifests: source id, hash, metadata, and last known filename.
- Re-opening a project may require re-uploading the same file; it reconnects by hash, not filename.
- Server routes receive text/JSON context and, for vision routes only, selected sampled frames/contact sheets.
- Provider keys are server-only. Do not create `NEXT_PUBLIC_*` variables for secrets.

## Main editing modes

| Mode | Use case | What happens |
|---|---|---|
| `plan` | General highlight request | Builds an `EditPlan` and runs the visual pipeline when executed. |
| `moment` | Find one specific moment | Scores candidate frames and returns the best matching clip. |
| `extract` | Exact time slice | Creates a precise clip, e.g. first 30s or 0:30-1:00, with no scoring. |
| `edit` | Timeline mutation | Trims, drops, splits, resets, undo/redo; no analysis run. |
| `describe` | Question about a clip/range | Samples frames from the target and asks a vision endpoint; timeline is unchanged. |
| `briefing` | Describe the video / best parts | Returns overview and best-part suggestions without rendering. |
| `promote` | Use briefing best parts | Converts stored briefing ranges into timeline highlights without new vision. |
| `merge` | Join whole videos | Concatenates selected sources as full-duration clips; no visual analysis. |
| `compose` | Multi-source montage | Runs real per-source selection, orders clips, and applies transitions. |
| `acknowledge` | User gives context | Stores/acknowledges useful context without changing the timeline. |
| `clarify` | Ambiguous request | Asks a focused follow-up question. |

## Tech stack

| Layer | Choice | Role |
|---|---|---|
| Framework | Next.js 15 App Router + React 19 + TypeScript | Web app, route handlers, Vercel-ready deployment. |
| State | Zustand | Editor source of truth: sources, timeline, chat, status, memory, restore state. |
| Storage | IndexedDB / `idb-keyval` | Sessions, source manifests, predictions cache, transcripts, logs, agent memory. |
| Frame sampling | `mediabunny` | Browser-side media/frame access. |
| Local vision | `@huggingface/transformers` + SigLIP worker | In-browser semantic frame scoring on capable devices. |
| Local audio | Whisper via transformers.js | Local transcript generation for speech/text-grounded edits. |
| Render | Mediabunny/WebCodecs, then `@ffmpeg/ffmpeg` fallback worker | On-device MP4 creation. |
| Cloud planner / vision | OpenRouter -> Gemini -> Groq/custom provider | Optional server-side model calls for structured JSON planning/vision. |
| Auth/session | `iron-session` signed cookie | No login required; session id for budget/rate-limit tracking. |
| Rate limits | Optional Upstash Redis | Protects shared API keys and global model budget. |

## AI / provider behavior

Cloud AI is **disabled by default**. In `lib/env.ts`, `cloudAiDisabled()` returns `true` unless `DISABLE_CLOUD_AI` is explicitly set to `false`, `0`, or `off`.

When cloud AI is enabled, provider routing goes through `lib/providers/cloud.ts`:

```text
OpenRouter -> custom OpenAI-compatible provider -> Gemini -> Groq
```

The configured order can be overridden with the server-only `CLOUD_PROVIDER_ORDER` environment variable. Groq is text-only and is skipped for vision calls.

The editor also has deterministic local paths that do not require a cloud model:

- read-only explanation/question guard,
- fast commands such as undo, redo, render, export,
- exact range extraction and direct timeline edits,
- merge of whole selected videos,
- local/offline best-parts fallback from motion/saliency where supported,
- optional WebLLM text-only recovery when explicitly enabled.

## Getting started

### 1. Install

```bash
npm install
```

### 2. Configure environment

For local deterministic/offline development, provider keys are not required.

For cloud planning/vision, copy `.env.example` to `.env.local` and set at least:

```bash
DISABLE_CLOUD_AI=false
SESSION_SECRET=replace-with-32-byte-random-hex
OPENROUTER_API_KEY=optional-openrouter-key
GEMINI_API_KEY=optional-gemini-key
GROQ_API_KEY=optional-groq-key
UPSTASH_REDIS_REST_URL=optional-upstash-url
UPSTASH_REDIS_REST_TOKEN=optional-upstash-token
```

Recommended session secret generator:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Optional provider controls:

```bash
CLOUD_PROVIDER_ORDER=openrouter,gemini,groq
OPENROUTER_DEFAULT_MODEL=google/gemini-2.5-flash
OPENROUTER_MAX_TOKENS=2048
CUSTOM_OPENAI_API_KEY=...
CUSTOM_OPENAI_BASE_URL=...
CUSTOM_OPENAI_ENABLE_VISION=true
```

### 3. Run dev server

```bash
npm run dev
```

Open `http://localhost:3000`.

The app needs cross-origin isolation headers for SharedArrayBuffer-backed browser features such as ffmpeg.wasm and transformers.js. The Next.js app/middleware is expected to provide the required COOP/COEP behavior.

### 4. Validate locally

```bash
npm run typecheck
npm run build
npm test
```

`npm run lint` is present in `package.json`, but the project memory notes that standalone Next lint setup may be interactive unless an ESLint configuration is already present.

## Deploying to Vercel

1. Connect the GitHub repository to Vercel.
2. Set the server-side environment variables needed by your deployment.
3. Push to `main` or merge a PR.
4. Vercel builds with `npm run build`.

For cloud AI deployment, set `DISABLE_CLOUD_AI=false` and at least one provider key. Without that, the app should keep deterministic local/manual paths available and skip cloud model calls.

### Verify the deployment

- Open the app and upload a small MP4.
- Try a deterministic command: `add first 10 seconds`.
- Try undo/redo.
- Render and export the result.
- If cloud AI is enabled, try `make a 30 sec reel of the best parts`.
- For WebGPU features, test in a real browser/device; CI/headless environments do not verify SigLIP, Whisper, captioning, or live model calls.

## Core workflows

### General highlight request

```text
User: make a 40 sec reel of the best moments
```

Expected path:

1. Agent/intake/planner resolves a plan.
2. Browser samples frames from eligible selected sources.
3. The score path fuses semantic, motion, and saliency signals.
4. Candidate windows are detected and optionally verified through vision.
5. Highlights are built and checked against target-coverage guardrails.
6. Timeline becomes ready or needs review if the target is badly underfilled.

### Exact range request

```text
User: add first 30 seconds
```

Expected path:

- The app creates an exact `Highlight` for the range.
- No semantic scoring is required.
- Existing timeline clips are preserved unless the user explicitly asks to replace/reset.

### Multi-source compose

```text
User: combat from the first video and cutscene from the second, make it transition
```

Expected path:

- Compose intent is detected before generic single-source planning.
- Each requested source gets its own sub-plan.
- The real per-source pipeline runs; no fake vision data is used.
- Clips are ordered and transitions are applied to the shared timeline.
- Previous timeline state is undoable.

### Whole-video merge

```text
User: just merge all videos
```

Expected path:

- No sampling/scoring.
- Selected videos become full-duration clips in source order.
- The user renders the joined output.

## Project restore model

Saved project history stores metadata, not video bytes. On reload, the app knows which sources and clips existed, but it cannot render until the user re-uploads the required file(s). A re-upload reconnects to the original project source by SHA/hash.

This keeps storage low and avoids persisting large private video blobs silently.

## Important files

| Path | Purpose |
|---|---|
| `app/editor/page.tsx` | Main editor orchestration: chat, agent layers, pipeline, render/export, persistence. |
| `app/api/agent/route.ts` | Main planner endpoint and mode dispatcher. |
| `app/api/agent/briefing/route.ts` | Whole-video briefing endpoint. |
| `hooks/useEditorStore.ts` | Zustand editor state and timeline/source actions. |
| `hooks/useFFmpeg.ts` | Browser render hook, Mediabunny-first with ffmpeg fallback. |
| `hooks/useExport.ts` | Direct file export/download behavior. |
| `lib/types.ts` | Central domain types. |
| `lib/config.ts` | Central tunables and guardrails. |
| `lib/env.ts` | Server-only environment access. |
| `lib/providers/cloud.ts` | Provider dispatcher. |
| `lib/intent/videoPromptInterpreter.ts` | Messy video-prompt slot extraction. |
| `lib/agent/runAgentCommand.ts` | Deterministic editor-agent command bridge. |
| `lib/pipeline/executePerSource.ts` | Per-source sample -> score -> temporal -> highlight flow. |
| `lib/pipeline/score.ts` | Semantic/motion/saliency scoring. |
| `lib/store/projectRestore.ts` | Blob-free project restore and hash-based source hydration. |
| `lib/transitions/*` | Per-boundary transition mapping and auto-pick logic. |
| `memory/*` | Project state, constraints, TODOs, roadmap, decisions, changelog, dated implementation notes. |

## Current limitations

- Browser/WebGPU runtime cannot be verified by CI alone.
- Live provider calls require real API keys and deployment/browser testing.
- Full video blobs are not persisted by default, so restored projects require re-upload.
- True overlap crossfade and richer transition effects are future work; unsupported effects are mapped down honestly.
- Some local-first modules such as deeper frame-tree/caption reasoning are merged but not fully wired into the live planner path.
- Long videos on low-memory devices can still be constrained by browser decode/render limits.

## Development rules for contributors

Before non-trivial work:

1. Read `memory/INDEX.md`.
2. Follow its reading order.
3. Treat `memory/PROJECT_STATE.md` as the current status source of truth unless code proves otherwise.
4. Read files before editing them.
5. Keep changes focused.
6. Update relevant memory files after changes.

Hard constraints:

- Do not upload full user video off-device.
- Do not expose provider secrets to the browser.
- Do not bypass the cloud provider dispatcher.
- Do not weaken rate-limit or cost guards.
- Do not silently change working logic.
- Be explicit about what was verified versus what still needs browser/API testing.

## License

MIT — do whatever you want, just do not blame us if your highlight reel cuts mid-touchdown.

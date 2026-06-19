# Shorts Studio

**Universal Video Shorts Editor** — turn long videos into platform-ready short clips through conversation. Browser-first, free-tier friendly, no Python anywhere.

## What it does

1. You upload a video (it never leaves your device).
2. You describe the short you want in chat.
3. The AI emits an `EditPlan`: scenarios, weights, target duration, format, transitions.
4. The browser samples frames, scores each frame against your scenarios, finds candidate windows, sends a contact sheet of each window to a vision model for a keep/skip verdict, then assembles the highlight reel.
5. ffmpeg.wasm renders the final MP4 in a Web Worker. You preview, share, or download.

### Fast, dynamic local analysis

The editor behaves like a human editor instead of always scanning the whole
video. A per-request **analysis budget** (`lib/analysis/budget.ts`) decides how
much local work each turn deserves — there is no single fixed frame cap:

- Exact edits ("add the first 30 seconds"), control commands (render/export),
  read-only questions ("why this clip?"), and whole-video merges run with **no
  frame analysis** — they respond instantly.
- **"Describe what's in this video"** does a quick, honest local read instead of
  building a short: it never runs the highlight pipeline.
- "Best parts" scans **fewer frames on a short clip and deeper (still bounded)
  on a long video**, scaled by your device tier; a cached scan is reused.

Heavier passes are coarse-to-fine (a light scan first, deep analysis only on
the strongest candidate windows). All of this stays **on-device** — the video
bytes never leave the browser, and API keys are server-only.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 15 App Router + React 19 + TypeScript | One codebase, Vercel-ready |
| Chat planner | Gemini 2.5 Flash (Groq fallback) | Free tier, JSON mode |
| Vision (per-frame) | SigLIP via `@huggingface/transformers`, in-browser WebGPU | $0, no upload, no quota |
| Vision (temporal) | Gemini 2.5 Flash on contact sheets | One call per window |
| Frame sampling | mediabunny | Pure browser, fast |
| Render | `@ffmpeg/ffmpeg` in a Web Worker | $0, on-device |
| Storage | IndexedDB (`idb-keyval`) | Per-device sessions, history, prediction cache |
| Rate limit | Upstash Redis (free tier, optional) | Protects API keys |
| Auth | iron-session signed cookie | No login required |
| PWA | Manifest + custom service worker | Installable, offline-capable |

## Getting started

### 1. Install

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env.local` and fill in:

```bash
GEMINI_API_KEY=...           # https://aistudio.google.com/apikey (free)
GROQ_API_KEY=...             # https://console.groq.com (free, optional fallback)
SESSION_SECRET=...           # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
UPSTASH_REDIS_REST_URL=...   # https://console.upstash.com (optional)
UPSTASH_REDIS_REST_TOKEN=...
```

Every variable is **optional for local dev**. The app degrades gracefully:
no `GEMINI_API_KEY` → chat falls back to Groq; no `UPSTASH_*` → rate limiting disabled.

### 3. Run dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Note the dev server enforces COOP/COEP, which is required for SharedArrayBuffer (used by ffmpeg.wasm and transformers.js).

### 4. Build / typecheck / lint

```bash
npm run typecheck
npm run lint
npm run build
```

## Deploying to Vercel

1. Connect your GitHub repository on Vercel.
2. Add the environment variables from `.env.example` to the Vercel project.
3. Push to `main` (or merge a PR). Vercel will build with `npm run build`.

That's it. No `vercel.json` rewrites are needed — the App Router handles routing. The `vercel.json` in this repo only configures function durations.

### Verify the deployment
- `GET /api/health` returns `{ ok: true, vision: true, chat: true }` if both keys are set.
- Open the site, try the install prompt on mobile — it should be installable.

## Architecture

```
Browser:
  mediabunny ──► SigLIP worker ──► event detection ──► Gemini contact-sheet pass
                                                              ▼
                                                     build_highlights
                                                              ▼
                                                        ffmpeg.wasm
                                                              ▼
                                                       <video> + share

Server (Next.js Route Handlers): just authenticated proxies for Gemini/Groq.
No video data ever flows server-side.
```

The full project layout is documented in [`CHANGELOG.md`](./CHANGELOG.md) and the section comments on each file.

## Free-tier capacity at $0/month

- ~250 user-initiated edits/day across all users (Gemini free quota)
- Unlimited per-frame scoring (runs on-device)
- Unlimited rendering (runs on-device)
- ~100 GB egress/month (Vercel hobby cap)
- ~7,500 edits/month sustainable

## Known limits in v1.0.0

- Long videos (>5 min) on phones may OOM during render. Mitigation: cap input to 720p, render in segments. Bigger inputs need cloud render (deferred to v2).
- Sessions live per-device. Cross-device sync is in v2.
- Captions, multi-output edits, and recipe library are v2.

## License

MIT — do whatever you want, just don't blame us if your highlight reel cuts mid-touchdown.

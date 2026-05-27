# Changelog

All notable changes to Shorts Studio are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to semantic versioning.

## [1.3.0] — 2026-05-27

### Added
- Adaptive percentile-based candidate selection (`lib/pipeline/adapt.ts`).
  Replaces the hardcoded 0.15 score floor with a percentile derived from
  user tier, selection strategy, and the score distribution. The "0 clips"
  failure mode is gone — even videos with low absolute scores produce
  candidates.
- User-tier classifier (`lib/plan/intent.ts → classifyUserTier`):
  novice (vague prompts) gets a wide net + force-min so they always get
  ≥1 clip; advanced (technical vocabulary, timestamps) gets stricter
  matching and an honest "no match" if their query was too specific.
- `confidence: "high" | "medium" | "low"` on every highlight, derived
  from the composite score.
- Force-min fallback in `buildHighlights`: if normal selection returns 0
  for a novice user, the top candidate(s) come back with a low-confidence
  flag so the user gets something to work with.

### Changed
- `detectCandidateWindows` now returns `DetectionResult` (windows + stats
  + cutoff + percentile) so callers can build helpful diagnostics.
- `buildHighlights` now returns `BuildResult` (highlights + weakOnly +
  consideredCount) instead of `Highlight[]` directly.
- Every selection knob now lives in `lib/config.ts → ADAPT` and is read
  by pure derivation functions in `lib/pipeline/adapt.ts`. No fixed
  thresholds anywhere in the pipeline.

### Notes
- `lib/pipeline/extract.ts` was added but isn't wired up to the planner
  in this version. Time-bounded queries like "first 1 minute" still go
  through scoring; routing them through extract is v1.3.1 work.

## [1.2.1] — 2026-05-27

### Fixed
- **`When both options.width and options.height are provided, options.fit
  must also be provided.`** — mediabunny's `CanvasSink` requires a `fit`
  mode whenever both dimensions are passed. Added `fit: "fill"` (we
  already pre-compute height to match source aspect, so "fill" is exact
  with no stretching). Same fix flows through the temporal pass which
  reuses `sampleFrames`.

### Added
- **Plan-first-then-execute confirmation step.** New `PlanPreview` card
  (`components/PlanPreview.tsx` + `.module.css`) shows the resolved plan
  as chips (target / format / transition / scenarios / avoid) plus a
  primary **Run analysis** and secondary **Adjust** button. The
  expensive frame-analysis pipeline only runs when the user confirms.
- New `pendingExecution: boolean` slice in `useEditorStore`. Set after
  any plan or scenarios-changed refinement; cleared on confirm or after
  the pipeline finishes.
- **Auto-run for cache-reusable refinements.** When a refinement
  ("make it 60s") doesn't change scenarios, the pipeline auto-runs
  because the predictions cache makes it instant. Only fresh plans and
  scenarios-changed refinements wait for the Run button.
- **Meta-question example** in the planner system prompt: "what info do
  you need?" / "help" now correctly classifies as `clarify` mode rather
  than emitting a fabricated default plan.

### Changed
- **Strict message format** in the planner prompt: ≤ 20 words, one
  sentence, conversational, no `Plan:` / `Looking for:` / `Avoiding:` /
  `Why:` prefixes. Detailed plan parameters belong in the `plan` object
  (rendered as chips), not in the user-facing message.
- **Defensive server-side cleanup**: `app/api/agent/route.ts` now passes
  every planner message through `cleanMessage()` which strips section
  prefixes and caps length at 160 chars. This keeps the chat readable
  even when the LLM ignores the brevity rule.
- `clearVideo` now also resets `pendingExecution` so removing the
  source clears the confirmation card.

## [1.2.0] — 2026-05-27

### Added
- **Activity log** capturing every AI pipeline step and every manual user
  action with typed payloads, dedupe, and an in-app drawer with filters
  (All / AI / Manual / System) and per-row payload expansion.
- **Activity-aware planner**: each `/api/agent` call sends a compact
  "Recent activity" summary built from the last ≤12 events. The planner
  reads these signals as implicit memory — repeated leftward nudges
  bias toward earlier moments, repeated removals downweight a scenario,
  etc. Documented in `lib/plan/prompt.ts`.
- **Multi-layer rate limit** designed so the deployed instance stays up
  even under viral load:
  1. Edge IP throttle (`middleware.ts` + `lib/ratelimit/edge.ts`).
  2. Session burst + daily caps per scope (`lib/ratelimit/index.ts`).
  3. Global daily Gemini budget guard with soft (70%) + hard (95%)
     thresholds (`lib/ratelimit/global.ts`).
  4. Per-provider circuit breaker (`lib/ratelimit/circuit.ts`).
- **Punishment tier** for sessions that hit limits ≥5×/day — auto
  throttled to 1 req/min for the rest of the UTC day.
- **Quota banner** (`components/QuotaBanner.tsx`) shown when the global
  budget enters the soft tier; dismissible per UTC day.
- **Admin stats endpoint** at `GET /api/admin/stats` (gated by the
  `ADMIN_TOKEN` env var; returns 404 if unset). Reports current Gemini
  budget, both circuits, and env presence.
- **Security headers** in middleware: HSTS, CSP (lenient enough for
  ffmpeg.wasm + transformers.js CDN), Permissions-Policy,
  Referrer-Policy, X-Frame-Options, X-Content-Type-Options.

### Changed
- `app/api/agent/route.ts`, `app/api/vision/window/route.ts`, and
  `app/api/vision/frame/route.ts` now go through `checkAllLimits` (Layers
  2/3/4) and report rate-limit decisions as `{ mode: "error", transient,
  retryAfterSeconds }` for predictable client UX.
- `AgentRequest` gained a `recentActivity?: string` field. Plan/Moment/
  Clarify response shapes gained an optional `quotaWarning` so the
  client can render the soft-tier banner.
- The Topbar now hosts an **Activity** button with a green dot indicator
  for unread events. The clips drawer is unchanged.
- `lib/store/idb.ts` exposes a third dedicated KV store
  (`shorts-studio-logs`) for the activity log so log writes don't churn
  the session/cache stores.
- `lib/log/store.ts` debounces IDB writes by 250ms (configurable via
  `ACTIVITY.flushIntervalMs`) and dedupes identical consecutive events
  within `ACTIVITY.dedupeWindowMs` into a single row with a `count`.

### Steering
- Appended Section 9 to `.kiro/steering/conversation-patterns.md`
  documenting the activity-log policy and the four-layer rate-limit
  contract so future sessions don't accidentally regress them.

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

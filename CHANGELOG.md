# Changelog

All notable changes to Shorts Studio are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to semantic versioning.

## [1.5.0] — 2026-05-27

### Added — Visual multi-signal scoring (zero new models, zero new API cost)

The planner can now decompose any prompt into a weighted blend of three
visual signals — and pick which signals to use per turn. Concrete
"goalkeeper save" queries lean on semantic. "Best parts" / "interesting
bits" queries fall back to motion + saliency, which the pipeline computes
for free during sampling. No new model downloads, no new server calls.

- **Motion signal** — frame-to-frame brightness pixel-difference,
  computed inline in `lib/pipeline/sample.ts` while the canvas is
  already alive. ~1 ms per frame at 256 px, no model.
- **Saliency signal** — Shannon entropy of a 16-bin brightness
  histogram per frame. Captures "is this frame busy or flat".
- **Composite scoring** — `score = w_sem · semantic + w_mot · motion
  + w_sal · saliency`. The LLM emits the weights as a `signals` field
  in the plan; the executor renormalises and clamps.
- **SigLIP skip path** — when the planner emits `signals.semantic = 0`
  (which happens automatically for "best parts" prompts because the
  prompt has no concrete visual target), `lib/pipeline/score.ts`
  bypasses the SigLIP worker entirely. ~10–30 s of analysis time
  removed on a 10-minute source. Selection runs purely on the
  motion + saliency signals, which are already on every `SampledFrame`.

### Added — Extract mode (time-bound queries)

Wires `lib/pipeline/extract.ts` into the agent. Two flavours:

- **Top-level `mode: "extract"`** — verbatim time slice. The user said
  "first 1 minute", "last 90 seconds", "from 0:30 to 1:45" and that's
  it. Zero scoring, zero LLM vision calls. The pipeline produces
  exactly one Highlight covering the requested range.
- **`extractRange` field on a regular plan** — for "first 2 min and
  pick best of that". The pipeline filters `sampleFrames` to the
  range BEFORE scoring and selection, saving ~80 % of the analysis
  cost on long sources.

The planner picks `kind: "first" | "last" | "absolute"` so the client
resolves bounds from the actual video duration.

### Changed

- `FrameScore` now carries the per-signal contributions (`semantic`,
  `motion`, `saliency`) alongside the composite `score`. Old sessions
  load fine — the new fields are optional.
- `EditPlan` gained optional `signals` and `extractRange` fields.
  Backward-compatible: when missing, the pipeline picks a profile from
  `SIGNAL_DEFAULTS` (scenarioHeavy / balanced / visualInterest)
  based on whether scenarios are present.
- `IntentMode` extended with `"extract"`.
- `AgentResponse` gained the `extract` branch carrying `extractRange`.
- The planner system prompt teaches the LLM about both new mechanisms
  with explicit weight profiles per prompt category.
- `normalizePlan` now accepts `scenarios: []` when `signals.semantic`
  is 0 — the visual-interest-only path is a first-class flow rather
  than an error case.

### Cost & footprint

- **Browser:** zero new model downloads. Sampling cost goes up by
  about 1 ms per frame from the new pixel-stat passes. On a 10-minute
  source at 1 fps that's ~600 ms of additional CPU work — invisible
  next to SigLIP.
- **Server:** unchanged. Same Gemini call count per turn (1 planner +
  N temporal verifiers).
- **Persistent cost:** still $0/month at hobby scale.

### What this unlocks for users

| Prompt | Before | After |
|---|---|---|
| "edit first 2 min and pick best part" | Often returned 0 clips on monotonous footage | Frames inside [0, 120s] are scored on motion + saliency; novice tier always returns ≥ 1 clip |
| "best parts of this video" | Required the LLM to invent visual scenarios; SigLIP ran for ~30s | Skips SigLIP entirely; runs in seconds on motion + saliency |
| "give me the last 30 seconds" | Treated as a moment query, often missed | Verbatim slice in O(1), no scoring |
| "find the dunks" | Worked already | Unchanged — semantic-heavy weights kick in automatically |

### Files

New:
- (none — extends existing pipeline files)

Modified:
- `lib/pipeline/sample.ts`, `lib/pipeline/score.ts`,
  `lib/plan/prompt.ts`, `lib/plan/normalize.ts`, `lib/plan/merge.ts`,
  `lib/types.ts`, `lib/config.ts`, `app/api/agent/route.ts`,
  `app/page.tsx`, `package.json`, `CHANGELOG.md`.

## [1.4.0] — 2026-05-27



### Changed
- **No more regex on the server.** The conversational planner now does
  100% of intent understanding through the LLM:
  - Mode classification (`plan` / `moment` / `clarify`) is emitted
    directly in the structured JSON response.
  - User tier (`novice` / `advanced`) is classified by the LLM from
    tone and vocabulary, not from a keyword list — and is forwarded to
    the client through `AgentResponse.userTier`.
  - Format / duration / pacing inference moves entirely into the
    planner prompt.
- The system prompt is rewritten to a warmer, conversational voice and
  no longer references heuristic hints, intent regexes, or any
  internal keyword lists.

### Fixed
- **Moment mode no longer dead-ends novice users.** The
  `buildMomentHighlight` pipeline now mirrors the v1.3.0 force-min
  fallback from `buildHighlights`: when no candidate window crosses the
  strong-match bar AND the user is novice tier, it returns the best
  available window flagged `weakOnly: true` with `confidence: "low"`
  instead of an empty array. Advanced users still get an honest
  "no match" because their queries are typically narrow on purpose.
- The chat copy that used to read *"I couldn't find any windows that
  strongly match…"* is replaced with friendlier guidance that suggests
  what the user could change. The "couldn't find" path now only fires
  when the pipeline truly has nothing to show.

### Removed
- `lib/plan/intent.ts` and every regex it contained
  (`MOMENT_PHRASES`, `ADVANCED_PATTERNS`, `REFINEMENT_PHRASES`,
  `RESET_PHRASES`, `VAGUE_PHRASES`, `extractDurationSeconds`,
  `extractFormat`, `inferFormatFromSource`, `inferTargetSecondsFromSource`,
  `inferPacing`, `classifyUserTier`, `inferIntent`).
- `INFERENCE_HEURISTICS` from `lib/config.ts` (keyword lists,
  source-length buckets, sports/talking pacing overrides) — the LLM
  now decides all of these per-turn from context.
- Two unused fields on `EVENT_DETECTION` (`thresholdStddevMultiplier`,
  `thresholdFloor`) that were superseded by the adaptive percentile
  detector in v1.3.0 but never deleted.

### Added
- `userTier` slice in `useEditorStore` (defaults to `novice`),
  populated from each agent response and read by every pipeline step.
- `MomentBuildResult` interface (`{ highlights, weakOnly,
  consideredCount, scoreStats }`) so the moment pipeline returns the
  same shape as `buildHighlights`'s `BuildResult`.
- New starter prompts in `AssistantPanel` that match the cleaned-up
  intent semantics (no more bare-word "find" trap).

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

# Chat Brain Preload + Dynamic Clip Durations — 2026-06-20

> Dated implementation note. Newest project-state summary lives in
> `memory/PROJECT_STATE.md`; this file is the detailed writeup for the v2.5
> change.

## Why

Two real-user gaps:

1. **First chat turn felt slow / sometimes looped.** Free-text answers to a
   pending clarify question relied solely on the deterministic resolver; an
   ambiguous reply could fail to merge and re-ask the SAME question. There was
   also no warmed text model to fall back on, so the first ambiguous turn paid
   full cold-start latency.
2. **Every clip was ~3s.** `tryOfflineBestParts` forced
   `minUsefulSeconds = max(3, plan.minClipSeconds)`, so reels were a row of
   identical 3s blocks regardless of video length or how strong each peak was.

## What shipped (live)

### A. Privacy-safe text-only Chat Brain (intent / clarify-answer fallback)

- **`lib/config.ts` → `CHAT_BRAIN`** — master switch (`preloadEnabled`),
  `preloadDelayMs` 800, `preloadOnEditorMount` / `preloadOnUploadStart`,
  `cloudWarmupEnabled` true, `localWarmupEnabled` false (heavy, off by default),
  `maxWarmupMs` / `resolveTimeoutMs`, device gating (`minDeviceMemoryGb` 4,
  `skipWhenSaveData`), and the confidence gate
  (`useOnlyForLowConfidence`, `confidenceThreshold` 0.72, `minApplyConfidence`
  0.6). No magic numbers in code.
- **`lib/llm/chatBrainSchema.ts`** — the PRIVACY BOUNDARY. `ChatBrainIntent`
  type + `parseChatBrainIntent` strict runtime validator;
  `buildChatBrainPayload` builds the ONLY thing sent to the model: compact text
  state (previous assistant message, the question, the field being resolved,
  the user's typed answer, and a few scalar editor facts — clip count, target
  seconds, selected-source count, pending action kind). `FORBIDDEN_PAYLOAD_KEYS`
  + `payloadHasForbiddenKeys` reject any payload that smuggles media / frames /
  blobs / file paths / keys.
- **`app/api/agent/intent/route.ts`** — server route, two tasks: `warmup` (cheap
  text ping that reuses `cloudPlannerJson` to warm the provider) and `resolve`
  (text-only intent resolution). Rejects forbidden keys; returns `unavailable`
  (not an error) when no provider is configured, so the app stays in
  deterministic mode silently.
- **`lib/llm/chatBrainPreload.ts`** — client controller: idempotent
  `preloadChatBrain`, `getChatBrainStatus` / `subscribeChatBrain` /
  `chatBrainReady`, `resolveWithChatBrain`, `shouldPreload` (device gating),
  `__resetChatBrainForTest`. **Uses RELATIVE imports (`../config`)** — the
  node:test `.ts` hook requires this for value imports.
- **`hooks/useChatBrainPreload.ts`** — starts warmup after mount and on first
  upload via `requestIdleCallback` (non-blocking).
- **`lib/agentic-intake/llmPendingAnswerResolver.ts`** —
  `resolvePendingAnswerWithBrain` is **deterministic-first**: it runs the
  existing `resolvePendingAnswer` and ONLY consults the brain
  (`shouldConsultBrain`) when that confidence is below `confidenceThreshold`.
  `chatBrainIntentToAnswer` maps a brain result back into the existing
  `PendingAnswer` shape; a brain answer must clear `minApplyConfidence` to be
  applied. Also relative imports.
- **`components/ChatBrainBadge.tsx`** — tiny status pill (idle / warming /
  ready / unavailable) added to the `AssistantPanel` header next to the
  AI-mode + capability badges.
- **`app/editor/page.tsx`** — `useChatBrainPreload({ uploadStarted: hasAnySource })`
  wired; the pending-answer block now calls the async
  `resolvePendingAnswerWithBrain` with a privacy-safe text context, logs
  `intent.llm.used` / `intent.llm.fallback`, and adds an **anti-loop guard**:
  if intake still wants the SAME question id after a usable answer, it does NOT
  re-ask — it compiles the brief and proceeds to the planner
  (`intake.loop.prevented`).

**Hard privacy rules kept:** no video bytes, frames, thumbnails, raw audio, raw
transcript body, API keys, file paths, or binary ever reach the model — only
compact text state. Deterministic commands (undo/redo/render/export/trim,
yes/no with a pending action) NEVER touch the brain. The brain is fallback-only
for low-confidence free text.

### B. Dynamic clip durations (min ~1s, max scales with video)

- **`lib/config.ts` → `CLIP_DURATION`** — `absoluteMinSeconds` 1,
  `absoluteMaxSeconds` 30, `minFractionOfVideo` 0.01 (`minCeilingSeconds` 3),
  `maxFractionOfVideo` 0.06 (`maxFloorSeconds` 4), `preferredBetween` 0.45,
  `preferredClipsForTarget` 6. Guardrails only — the user's explicit min/max
  always wins.
- **`lib/pipeline/clipDuration.ts`** — pure `deriveClipDurationBounds({ videoDuration,
  targetSeconds })` (min/max/preferred clamped from the source length + target)
  and `clipLengthForScore(score, bounds)` (stronger interest peak → longer clip,
  toward max; weaker → toward min).
- **`lib/pipeline/bestParts.ts`** — `buildOfflineBestParts` takes an optional
  `preferredSeconds`; each candidate's expansion target is now
  `clipLengthForScore(...)` so clip lengths VARY instead of collapsing to one
  value. Back-compatible (falls back to `OFFLINE_BEST_PARTS.preferredClipSeconds`).
- **`lib/pipeline/highlights.ts`** — `tryOfflineBestParts` now derives bounds via
  `deriveClipDurationBounds` instead of the flat `max(3, plan.minClipSeconds)`
  floor, and passes `preferredSeconds` through.

## Tests added

- `lib/llm/chatBrainSchema.test.ts` — schema validation + privacy boundary
  (forbidden keys rejected, payload contains only compact text).
- `lib/llm/chatBrainPreload.test.ts` — idempotent preload, status transitions,
  device gating, fallback when unavailable (fetch mock + `__resetChatBrainForTest`).
- `lib/agentic-intake/llmPendingAnswerResolver.test.ts` — deterministic-first
  (high-confidence answer never consults the brain), low-confidence consults,
  `minApplyConfidence` gate, deterministic commands untouched.
- `lib/pipeline/clipDuration.test.ts` — bounds clamp from video length + target,
  score-scaled length monotonicity, absolute min/max respected.

All four registered in the main `npm test` script.

## Validation

- `npm run typecheck` — clean.
- `npm test` — **522 pass / 0 fail** (+30 vs the 492 baseline).
- `npm run test:analysis` — 104 pass / 0 fail.
- `npm run build` — success; `/editor` First Load **208 kB**;
  `/api/agent/intent` route present.

## Browser verification

NOT performed — the sandbox has no GPU/WebGPU/media decode and no live LLM
provider key. The deterministic paths are fully exercised by unit tests; the
cloud warmup/resolve round-trip and the on-device clip-length feel need a real
browser + a configured provider. See the matching TODO entry.

## Known limitations / honest scope

- The brain is **text-only** and **fallback-only**; with no provider key the
  app silently stays deterministic (the badge shows "unavailable").
- `localWarmupEnabled` is OFF — no in-browser model is downloaded for warmup.
- Dynamic clip bounds apply to the OFFLINE best-parts path
  (`tryOfflineBestParts`); other pipeline branches keep their existing sizing.
- No conversation/genre/phrase tables were added; the resolver stays generic.

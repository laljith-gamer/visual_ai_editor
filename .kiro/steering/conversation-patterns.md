# Conversation patterns for Shorts Studio

This file is the canonical specification for how the AI editor talks to
users. Every change to `lib/plan/prompt.ts`, `lib/plan/intent.ts`,
`lib/plan/merge.ts`, or `app/api/agent/route.ts` must preserve these rules.

## 1. Three intent modes per user turn

The planner classifies every turn into exactly one of:

- **MOMENT** — the user describes ONE specific scene to extract
  ("find the part where the goalkeeper saves the penalty", "the moment
  he laughs"). Run the dedicated `lib/pipeline/moment.ts` pipeline. Return
  exactly **one** clip.
- **PLAN** — the user wants a multi-clip highlight reel. Run the
  standard `sample → score → events → temporal → highlights` pipeline.
  Return 3–8 clips.
- **CLARIFY** — the request is genuinely ambiguous *and* inference
  cannot fill the gaps. Ask 1–2 specific questions; render quick-reply
  chips on the client. Do not run a pipeline.

## 2. Defaults policy: think before asking

When information is missing, the planner attempts these in order. It
**never** silently substitutes a hardcoded default for a user input.

1. **Did the user state it in this turn?** Use it.
2. **Is it in `memory` from prior turns of this session?** Use it
   silently — no need to mention.
3. **Can it be reasonably inferred from context?** (Source video
   duration, aspect ratio, prior conversation topic, prompt keywords
   like "TikTok"/"Reel"/"podcast".) Use the inference and **explicitly
   surface the assumption** in the response's `inferred[]` array so the
   user can correct it.
4. **None of the above?** Switch to CLARIFY mode and ask one targeted
   question with quick-reply chips.

The fake fallback scenarios that used to live in `normalizePlan`
(`{ id: "highlight", prompt: "visually engaging moment" }`) have been
removed. If scenarios cannot be derived, the planner asks.

## 3. Memory persists; pipeline does not restart

- A new chat turn never wipes the source video, plan, highlights,
  rendered output, or predictions cache.
- Refinement messages produce a partial plan **patch**, merged via
  `lib/plan/merge.ts` into the current plan.
- Predictions cache (per `videoHash + scenarioSignature`) is reused
  whenever scenarios didn't change.
- Only an explicit "start over" / "restart" / "reset" command (or the
  topbar "New chat" button) clears state.

## 4. All tunables live in `lib/config.ts`

Never inline a magic number in pipeline code. Threshold multipliers,
scoring weights, sample widths, contact-sheet dimensions, plan defaults,
and inference heuristic constants all live in `lib/config.ts` as
documented named constants. The planner can override these per-request
through the `EditPlan` it returns.

## 5. Inference heuristics (lib/plan/intent.ts)

Common, defensible inferences the planner is encouraged to make:

| Signal | Inference |
|---|---|
| Source aspect ratio is portrait | `format = "vertical"` |
| Source aspect ratio is landscape and prompt mentions YouTube/long-form | `format = "horizontal"` |
| Prompt mentions TikTok / Reel / Shorts | `format = "vertical"`, target ≤ 60s |
| Prompt mentions YouTube Short | `format = "vertical"`, target ≤ 60s |
| Source duration ≤ 60s | `target = min(source × 0.4, 30)` |
| Source duration ≤ 5 min | `target = 30s` if not specified |
| Source duration > 30 min | `target = 60s` if not specified |
| Prompt keyword "podcast" / "interview" / "lecture" | `maxClipSeconds += 4`, `sampleEverySeconds = 2` |
| Prompt keyword "sports" / "highlights" / "action" | `maxClipSeconds = 6`, `sampleEverySeconds = 0.5` |

Every applied inference is surfaced in `inferred[]` so the user sees
"format = vertical (because source is portrait)" and can override with
"actually make it horizontal".

## 6. Refinement detection

If `currentPlan` is non-null AND the new message is short/imperative
("make it shorter", "vertical please", "add the saves", "swap clip 2"),
treat it as a refinement:

- Send the existing plan + new message to the planner.
- Planner returns only the fields that change (`planPatch`).
- `mergePlan(currentPlan, patch)` produces the new plan.
- The pipeline is only re-run if scenarios actually changed.

## 7. Quick-reply chips for CLARIFY mode

Every clarify question must include `suggestions: string[]` with 2–4
plausible answers, plus the universal escape hatch
`"Tell me a specific moment instead"` which transitions the next turn
into MOMENT mode.

## 8. Things never to do

- Do not invent scenarios that the user didn't ask for.
- Do not guess the format if memory disagrees with inference; ask.
- Do not reset the chat unless the user explicitly says reset / start over.
- Do not show the user "I assumed X" for fields they explicitly stated.
- Do not show inferred badges for memory-derived fields (those are silent).

## 9. Activity log + rate limit (v1.2.0)

The chat planner is now activity-aware: every user action (chat, clip
move, resize, remove, nudge) and every AI pipeline step (plan, sample,
score, temporal verdict, render) is recorded to an append-only log in
IndexedDB and surfaced into the planner prompt as a "Recent activity"
block. The planner uses these signals as implicit memory.

Rate limiting is multi-layer and must stay this way:

  Layer 1 (edge IP)     enforced in middleware.ts
  Layer 2 (session)     burst + daily caps in lib/ratelimit/index.ts
  Layer 3 (global LLM)  daily Gemini budget in lib/ratelimit/global.ts
  Layer 4 (circuit)     per-provider breaker in lib/ratelimit/circuit.ts

The deployed instance must remain available even at 100% global budget:
return 503 with a friendly message, not a crash. All four layers fail
open if Upstash is unavailable — best-effort instead of total outage.

The activity log itself never leaves the device (browser-only IndexedDB).
Only a compact text summary (12 most recent events, max 30 minutes old)
is sent to the planner as part of the request body.

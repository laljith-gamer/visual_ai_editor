# 2026-06-19 — Questions are answered, not turned into clip searches

> Bug report: "Describe what's in this video" replied "I'll look for
> **describe** moments and build a short" and actually picked 14 clips +
> rendered; "tell me why did you pick these clips explain it" became "look
> for **tell and why and did and explain** moments". Questions were being
> turned into clip searches and builds. Fixed offline + deterministically.

## Root cause
Questions fell through the command gate to the deterministic planner
`deriveActionableIntent` (the offline fallback, since cloud AI is off by
default). Its STOPWORDS didn't include ask/explain words, so "describe" /
"tell" / "why" / "did" / "explain" survived as the content focus →
"<word> moments" scenarios → an actionable plan that auto-ran the pipeline.

## Fix (two layers)

### A. Client-side offline question answerer (primary)
- New `lib/agent/questionAnswer.ts` (pure, tested): `classifyQuestion(text)`
  → `explain_picks | describe_video | timeline_status | transitions_status |
  capabilities | null`, and `answerQuestion(kind, ctx)` that answers from
  the editor's OWN data and NEVER builds a short:
  - **explain_picks** — lists each timeline clip with its real
    `reason`/`label`/`score`/`confidence` ("why did you pick these clips").
  - **describe_video** — if a LOCAL transcript exists, summarises the speech
    (top keywords + opening line + duration); otherwise an HONEST statement
    ("your video stays on this device; I haven't visually analysed the
    frames offline — enable transcription for a real description"). No fake
    visual claims, no build.
  - **timeline_status** — lists clips + total duration.
  - **transitions_status** — lists per-boundary transitions + reasons +
    mapped-down notes.
  - **capabilities** — honest list of offline abilities.
- Wired in `lib/agent/runAgentCommand.ts` BEFORE the planner (after the fast
  + transition command gates): a classified question is answered and
  returns `handled: true`, so it never reaches the plan path. Conservative —
  only fires on clear question/explain intent; real builds ("pick best
  parts", "add first 10 seconds") are untouched.

### B. Server/offline planner hardening (defense-in-depth)
- `lib/plan/deriveIntent.ts` STOPWORDS now include ask/explain/meta words
  (describe, explain, tell, why, reason(s), summary/summarize, mean(ing),
  list, happen(s), did, does, your, …). So a pure question reduces to an
  EMPTY focus → `actionable: false` → it can never synthesise
  "<question-word> moments". A real subject after an ask verb still works
  ("describe the dragon fight" → "dragon fight" → actionable).

## Tests (+13 → 168 pass)
- `lib/agent/questionAnswer.test.ts` (10): classification of describe/
  explain/transitions/timeline/capabilities vs real build commands;
  explain_picks reads clip reasons; describe_video honest with/without
  transcript; transitions_status lists boundaries + mapped notes.
- `lib/plan/deriveIntent.test.ts` (+4): the two reported prompts +
  "summarize the video" / "what happens" are non-actionable; "describe the
  dragon fight" stays actionable.

## Honesty / offline
Fully offline, no WebGPU, no cloud. No fake visual description — when there's
no transcript and no visual analysis, the agent says so. Questions never
mutate the timeline or run the pipeline.

## Branch
On `feat/auto-transitions` (PR #61) — depends on its `boundaryTransitions`
store field for the transitions Q&A, so it ships with that PR.

## Validation
`npm run typecheck` ✓ · `npm run build` ✓ · `npm test` = **168 pass / 0
fail**. Browser/manual not run (sandbox has no GPU/decode).

# 2026-06-15 — Offline-first 5-minute analysis plan

## User requirement

Use offline/local AI first.

- User-visible chat response must arrive within 30–60 seconds.
- Full video analysis may continue for up to 5 minutes.
- Goal is production-level local/offline video editing assistance with privacy.

## Product contract

1. Acknowledge immediately.
2. Within 30–60 seconds, return a useful first answer from offline/local context.
3. Continue deeper local video analysis in the background for up to 5 minutes.
4. Update the timeline/briefing progressively as more local analysis completes.
5. Never claim the offline LLM saw frames directly; it reads the local video index.

## Architecture

### Stage 0 — Instant response, 0–2s

Show a short local-processing message and start a cancellable analysis job.

### Stage 1 — Offline LLM quick plan, 0–30/60s

Use the offline text planner first. Inputs:

- user request
- video metadata
- known cache/index summary if available
- current timeline/context

Output:

- brief user-facing answer
- structured edit-plan draft
- what the app is checking next

### Stage 2 — Coarse local video pass, 30–120s

Build/update a coarse video index:

- chapter windows
- sampled frames
- motion score
- saliency score
- scene-boundary hints
- optional local transcript/audio features

### Stage 3 — Focused local pass, 120–300s

Analyze likely moments more densely:

- selected candidate windows
- additional samples around peaks
- local embedding/caption/ranking where available
- timeline candidate scoring

### Stage 4 — Final local plan, by 5 minutes

Offline LLM reads the local index and returns:

- final highlight plan
- clip list with timestamps
- confidence notes
- what it could not verify offline

## Training direction

Train the offline text planner first. It should learn:

- fast acknowledgement responses
- mode classification
- JSON edit-plan generation
- no-vision honesty
- asking clarifying questions when needed
- reading local video-index summaries instead of hallucinating visuals

## Success metrics

- first chat response <= 30s preferred, <= 60s maximum
- analysis job completes useful coarse pass <= 2 minutes
- deeper pass completes <= 5 minutes
- valid JSON rate >= 99%
- correct mode classification >= 95%
- no-vision hallucination rate near 0%
- long-video frame count stays capped/adaptive

## Implementation notes

Use Web Workers for long-running local analysis. Persist index/cache by video hash. Keep UI responsive with cancellable/resumable jobs and progress text.

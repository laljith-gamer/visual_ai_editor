# 2026-06-15 — Offline-first 5-minute analysis plan

## User requirement

Use offline/local AI first.

- User-visible chat response must arrive within 30–60 seconds.
- Full video analysis may continue for up to 5 minutes.
- Goal is production-level local/offline video editing assistance with privacy.
- Prioritize fast response, stronger memory capability, and higher accuracy.

## Product contract

1. Acknowledge immediately.
2. Within 30–60 seconds, return a useful first answer from offline/local context.
3. Continue deeper local video analysis in the background for up to 5 minutes.
4. Update the timeline/briefing progressively as more local analysis completes.
5. Never claim the offline LLM saw frames directly; it reads the local video index.
6. Preserve memory across turns, sessions, and re-analysis using video-hash keyed indexes.
7. Improve accuracy by combining tree memory, graph links, retrieval, confidence, and user feedback.

## Architecture

### Stage 0 — Instant response, 0–2s

Show a short local-processing message and start a cancellable analysis job.

### Stage 1 — Offline LLM quick plan, 0–30/60s

Use the offline text planner first. Inputs:

- user request
- video metadata
- known cache/index summary if available
- current timeline/context
- persistent session memory
- prior tree-summary nodes for the same video hash

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
- retrieval over previous nodes and related graph links

### Stage 4 — Final local plan, by 5 minutes

Offline LLM reads the local index and returns:

- final highlight plan
- clip list with timestamps
- confidence notes
- what it could not verify offline
- memory updates for future turns

## Tree-memory approach

The local video understanding layer should use a tree:

- leaf nodes: short timestamp windows / frame groups
- mid nodes: small scene summaries
- scene nodes: larger scene groups
- chapter nodes: long-range sections
- root node: full-video summary

Each node should store:

- node_id
- parent_id
- start_time / end_time
- visual summary
- transcript / audio text when available
- OCR text when available
- objects/actions/tags when available
- embedding
- confidence
- timeline logs
- user feedback / accepted or rejected clips

Add graph links alongside the tree for:

- same topic
- same person/object
- repeated concept
- cause-effect
- earlier explanation to later result

## Training direction

Train the offline text planner first. It should learn:

- fast acknowledgement responses
- mode classification
- JSON edit-plan generation
- no-vision honesty
- asking clarifying questions when needed
- reading local video-index summaries instead of hallucinating visuals
- using persistent tree memory and prior user feedback

## Success metrics

- first chat response <= 30s preferred, <= 60s maximum
- analysis job completes useful coarse pass <= 2 minutes
- deeper pass completes <= 5 minutes
- valid JSON rate >= 99%
- correct mode classification >= 95%
- no-vision hallucination rate near 0%
- retrieval timestamp accuracy improves after feedback
- long-video frame count stays capped/adaptive
- repeated queries reuse cached memory instead of re-analyzing from scratch

## Implementation notes

Use Web Workers for long-running local analysis. Persist index/cache by video hash. Keep UI responsive with cancellable/resumable jobs and progress text.

Memory capability should be treated as a first-class feature, not only a log. The app should remember what it already understood about a video and reuse that tree/index for later chats.

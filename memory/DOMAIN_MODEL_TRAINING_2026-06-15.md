# 2026-06-15 — Domain model training direction

## User goal

Train a model specialized for the video-editing assistant domain.

## Decision

Do not train a foundation model from scratch. Build a domain training stack in layers:

1. Fine-tune a small text planner model for editor command understanding and JSON edit-plan generation.
2. Build a local video index from frames, motion, saliency, optional captions, and timestamps.
3. Train/evaluate retrieval and ranking logic on editor decisions: which segments are keep/drop/highlight-worthy.
4. Keep full video bytes local by default; use cloud only as optional teacher/evaluator if the user allows it.

## First model to train

Train the text planner first. It should learn to convert user requests into valid editor actions/plans:

- plan
- moment
- extract
- edit
- merge
- compose
- acknowledge
- clarify

This is cheaper, measurable, and directly useful. It should not pretend to see frames.

## Dataset format

Use JSONL conversations with input context and expected structured output.

Example fields:

- user_request
- video_meta
- video_library
- current_timeline
- memory
- expected_mode
- expected_plan_or_action
- expected_message

## Evaluation

Track:

- valid JSON rate
- schema-valid plan rate
- correct mode classification
- source-selection accuracy
- duration/format extraction accuracy
- hallucination rate
- no-vision honesty rate

## Later models

After the planner is stable:

- train/rank highlight selection using frame-level features and human choices
- add local caption/scene indexing
- use teacher-model outputs only to bootstrap labels, then review/correct them

## Privacy rule

Training data should be synthetic, user-owned, or explicitly consented. Do not collect private user videos automatically.

# 2026-06-15 — Production video optimization target

## Product target

Treat the editor as a production-level video understanding tool, not a short-demo prototype. It should stay fast, stable, and useful for short, medium, and very long videos.

## Current principle

Do not try to read every frame from long footage. Use adaptive, capped, hierarchical analysis:

1. Coarse pass across the full video.
2. Candidate/event detection.
3. Dense pass only around likely moments.
4. Render only selected timeline clips.

## Code change shipped

Commit `eb1f2762` updated `lib/pipeline/executePerSource.ts` so cache-miss sampling uses the configured frame cap and adapts the sampling interval for long videos.

Before this change, a 1-second sample interval could produce thousands of frames on long videos. Now the pass is capped by `SAMPLE_DEFAULTS.maxFrames` and the interval widens when needed.

## Why this matters

- Faster analysis on long videos.
- Lower memory pressure in the browser.
- Lower local model / cloud fallback workload.
- More predictable runtime for production use.

## Next production steps

- Add true hierarchical scene/chapter indexing for whole-video understanding.
- Improve briefing mode so long-video summaries summarize by chapters instead of only a small flat frame set.
- Add resumable/cancelable analysis jobs in the UI.
- Add visible progress details: sampled frames, effective interval, cache hit/miss, and estimated remaining time.
- Add build/runtime tests for long-duration sampling behavior.

## Validation status

Source-inspected and pushed. Vercel status for the optimization commit was pending when this memory note was written.

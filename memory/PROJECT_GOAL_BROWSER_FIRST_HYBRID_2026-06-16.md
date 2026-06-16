# 2026-06-16 — Project goal: browser-first hybrid AI video editor

## Goal statement

Build a browser-first AI video editor using a hybrid local reasoning and visual understanding pipeline.

## Core architecture

- A lightweight local LLM handles planning and edit-command reasoning.
- Frame-level visual models extract semantic signals from video frames.
- Full video files stay on-device by default.
- Cloud vision is optional and used only for higher-quality understanding when explicitly enabled.

## Product principles

1. Browser-first privacy: raw video bytes should remain local.
2. Local-first reasoning: the editor should answer and plan with local models where possible.
3. Grounded visual understanding: local frame analysis, tree memory, captions/tags/OCR/transcript, and confidence scores should feed the planner.
4. Optional cloud enhancement: cloud vision may improve quality, but it must not be required for core editing.
5. Multi-video support: single uploads and multi-video sessions should both build per-source memory and combined planner context.
6. Fast response: first useful chat response should arrive quickly, while deeper analysis continues progressively.

## Current implementation status

- Local WebLLM planner is enabled by default in local-only mode.
- Cloud model providers are disabled by default.
- Best-parts and vertical-reel prompts have deterministic local quick plans.
- Scored frames are now converted into a local video-memory tree and saved in IndexedDB.
- CSP allows WebLLM model shard downloads from Hugging Face redirected CDN domains.

## Next implementation target

Wire saved video-memory context back into local chat so follow-up answers can explain selected clips using stored tree nodes rather than only generic motion/saliency explanations.

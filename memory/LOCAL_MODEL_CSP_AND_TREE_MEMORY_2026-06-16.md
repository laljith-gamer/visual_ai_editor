# 2026-06-16 — Local model CSP and tree-memory wiring

## Context

The app is in local-only AI mode. Cloud providers are disabled by default. The browser local model must be able to load its model files and the app should save local video understanding data.

## Problems found

1. WebLLM model files were blocked by CSP because Hugging Face redirects model shards to additional CDN hosts.
2. Simple local prompts like vertical reel requests needed deterministic local quick plans when WebLLM was not ready.
3. Scored frames were not yet persisted as video tree memory.

## Changes shipped

- `715b75b2` — Added offline quick plan for vertical reel / short requests.
- `56d827cf` — Saves a local video-memory tree from scored frame predictions.
- `f7c81fea` — Allows Hugging Face redirected model CDN hosts in CSP via middleware.

## Current behavior

- Generic best-part and vertical-reel requests can produce a local plan without waiting for WebLLM.
- After frame scoring, the app builds a `FrameTree`, converts it to `VideoMemoryIndex`, and saves it in the local video-memory store.
- WebLLM model downloads are allowed from the Hugging Face redirect CDN hosts required by browser model loading.

## Validation

Vercel succeeded for `56d827cf`, `715b75b2`, and `f7c81fea`.

## Remaining work

- Load saved `VideoMemoryIndex` back into local chat responses.
- Replace generic clip explanations with node-level explanations from the tree.
- Add local caption/OCR/transcript stages for better semantic understanding.

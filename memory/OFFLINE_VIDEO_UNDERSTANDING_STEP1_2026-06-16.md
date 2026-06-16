# 2026-06-16 — Offline video understanding step 1

## Goal

Start offline video understanding by saving a local tree memory from scored frames.

## Shipped

- `lib/store/cache.ts` now builds a `FrameTree` after predictions are saved.
- The scored frames are mapped into safe tree inputs with numeric motion and saliency values.
- The resulting `FrameTree` is converted into `VideoMemoryIndex` and saved in the dedicated video-memory IndexedDB store.

## Commits

- `6c02a7d3` attempted persistence from scored frames.
- `56d827cf` fixed frame input typing by mapping optional score fields into required tree signals.

## Validation

Vercel succeeded for `56d827cf`.

## Next step

Load this saved video memory into local chat responses so follow-up questions can use tree nodes instead of only generic motion/saliency explanations.

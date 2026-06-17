# 2026-06-17 — Runtime console fixes

## Context

The deployed editor was shown running in Chrome DevTools during local scoring with these console messages:

1. `manifest.webmanifest` failed with HTTP 401.
2. Canvas2D warned that repeated `getImageData` readbacks should use `willReadFrequently`.
3. Transformers.js warned that dtype was not specified for the WebGPU `model` and defaulted to fp32.
4. A CSS preload warning appeared.

## Diagnosis

- The manifest file exists in `public/manifest.webmanifest` and `app/layout.tsx` points to `/manifest.webmanifest`.
- `middleware.ts` excludes `manifest.webmanifest`, so the app middleware is not the source of the 401.
- Therefore the 401 is treated as Vercel deployment protection/auth on the preview URL, not an application code bug. It affects PWA metadata/install behavior only; it does not block frame scoring or rendering.
- The Canvas2D and dtype messages are runtime warnings, not fatal errors.

## Changes shipped

- `lib/pipeline/sample.ts`: `readCanvasPixels()` now requests the 2D context with `{ willReadFrequently: true }` to hint the repeated frame-pixel readback path used for motion/saliency scoring.
- `lib/vision/siglip.worker.ts`: SigLIP WebGPU model load now specifies `dtype: "fp32"` explicitly. This preserves the previous default precision while removing the unspecified-dtype warning. Do not switch to `fp16`/quantized dtype without browser-runtime testing that the model variant exists and scoring quality is acceptable.

## Not changed

- No workaround was added for `manifest.webmanifest` 401 because the likely cause is Vercel deployment protection. Fix in Vercel settings or test through an unprotected production deployment if PWA install metadata is required.
- CSS preload warning was left untouched because it is a non-blocking Next/browser optimization warning.

## Validation

- Changes were pushed to `main` through GitHub commits.
- Typecheck/build were not run in this assistant environment. GitHub Actions should validate `npm run typecheck` and `npm run build` on push.
- Browser/WebGPU verification remains manual: reload the deployment, run a scoring pass, and check that the Canvas2D/dtype warnings are reduced/removed.

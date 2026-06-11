# DECISIONS

> A running log of important **technical and product decisions**, with the
> reasoning and impact. The goal: future sessions understand *why* the
> project is the way it is, and don't accidentally undo intentional choices.
>
> Add a new row at the **top** of the table (newest first). Keep entries
> short and factual. If a decision is later reversed, add a new row that
> supersedes it (don't delete history).

## How to add an entry

- **Date:** ISO format `YYYY-MM-DD`.
- **Decision:** what was decided, in one line.
- **Reason:** the main driver.
- **Impact:** what this affects (files, behavior, future work).

## Decision log

| Date | Decision | Reason | Impact |
|------|----------|--------|--------|
| 2026-06-11 | **Remove the in-browser WebLLM local LLM path; route language/tool decisions SERVER-SIDE via OpenRouter** (OpenAI-compatible), keeping Gemini/Groq as fallbacks. Provider order `OpenRouter → Gemini → Groq` (`CLOUD_PROVIDER_ORDER`). **Supersedes** the 2026-06-08 WebLLM decisions and the 2026-06-11 Hermes high-tier decision. | WebLLM meant multi-GB downloads, WebGPU/device instability, and couldn't be supported universally; a server-side API is simpler and works for everyone. API keys must never run in the browser. | Deleted `lib/llm/*` + `@mlc-ai/web-llm` + `LOCAL_LLM`/`LOCAL_FIRST` + `NEXT_PUBLIC_LOCAL_FIRST_EDITOR`. New `lib/providers/openrouter.ts` + `lib/providers/cloud.ts` + `OPENROUTER` config + env. App is no longer offline/local-LLM. Deterministic client actions (briefing follow-ups, quick shortcuts, promote/extract/reset) remain. |
| 2026-06-11 | **OpenRouter API key is SERVER-ONLY** (`OPENROUTER_API_KEY`); never `NEXT_PUBLIC_*`; vision uses OpenRouter only when the configured model is multimodal, else falls back to direct Gemini (no claim of full Gemini-vision replacement; no fake vision data). | Secrets must never reach the browser bundle; honesty about what actually works. | `serverEnv` only; verified key name absent from `.next/static`. Vision routes gate on `hasGemini() || hasOpenRouter()`. Full video bytes still never leave the browser — only sampled frames. |
| 2026-06-11 | Local-first **high tier** uses **Hermes-3-Llama-3.1-8B** (`q4f16_1-MLC`); Qwen2.5-3B becomes the mid fallback, Llama-3.2-1B stays low. Gemini stays as the cloud planner **and** the vision-briefing fallback. | Hermes-3 is on WebLLM's official `functionCallingModelIds` list (tool-use fine-tuned), so the flag-gated local tool router emits more reliable JSON decisions than a generic instruct model. Vision still needs real frame-tree/caption grounding, so Gemini vision must remain. | `LOCAL_LLM` in `lib/config.ts` only (plus additive `roles` metadata; runtime selectors unchanged). High tier downloads ~4.9 GB / needs more VRAM. No cloud-flow change; flag default still OFF; no fake vision data. Gemini cannot become optional until `lib/frame-tree` + `lib/vision/caption*` + `lib/vision-core` are wired with real data. |
| 2026-06-11 | Briefing follow-ups (and the flag-gated local-first path) dispatch **structured, intent-carrying action objects** (`BriefingFollowUp` / `LocalEditorAction`), not raw text; only deterministic, low-risk actions (`promote`/`extract`/`reset`) run client-side, while scoring/vision-dependent ones (`plan`/`moment`/`describe`/`merge`/`edit`) stay cloud-owned until real frame data exists. | A button click should carry the intent it represents instead of forcing the planner to re-guess from a sentence (the cause of the clarify loop). Executing only deterministic actions locally keeps the timeline safe and avoids faking vision/frame-tree data. | New `BriefingFollowUp` union + `lib/briefing/followups.ts` normalizer; `localFirst.ts` returns `kind:"action"`; editor maps both onto existing store paths. Cloud flow unchanged on flag-off / fall-through. |
| 2026-06-08 | Local-first features (reasoning engine, frame tree, captioning, local LLM) ship as **separate additive library modules** first, wired in later behind a flag. | Keep each piece independently reviewable; never regress the working Gemini flow. | New `lib/vision-core`, `lib/frame-tree`, `lib/vision/caption*`, `lib/llm`; integration is a later, flagged step. |
| 2026-06-08 | Use **WebLLM (`@mlc-ai/web-llm`)** for the local LLM, with a **pre-trained quantized** model (Qwen2.5 / Llama-3.2), not a custom-trained model. | Training in-browser isn't feasible; WebLLM gives offline WebGPU inference with OpenAI-style JSON mode. | Adds ~1GB first-run model download; needs WebGPU; CSP allows `raw.githubusercontent.com` for model libs. |
| 2026-06-08 | Keep a **deterministic engine as the fast path**; the local LLM is a fallback for free-form language; cloud Gemini is the last resort. | "Fast + offline + cheap" conflicts with large local models; determinism stays instant and reliable. | Defines the local-first chain order. |
| (seed) | Browser-first architecture: video never leaves the device; server proxies LLM calls only. | Privacy + $0/low-cost hosting on free tiers. | Shapes the whole pipeline; no video upload endpoints. |

> The bottom "(seed)" row documents a pre-existing foundational decision for
> context. Replace/extend as you learn more about the project's history.

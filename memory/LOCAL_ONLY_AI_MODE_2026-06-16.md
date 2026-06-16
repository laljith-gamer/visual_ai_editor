# 2026-06-16 — Local-only AI mode

## User request

Use local LLM alone for now and turn off cloud AI providers.

## Change made

Cloud model providers are disabled by default and local WebLLM planner flags are enabled by default.

## Files changed

- `lib/local-llm/config.ts`
- `lib/env.ts`
- `.env.example`

## Behavior

- `DISABLE_CLOUD_AI` is now server-side and defaults to disabled when unset.
- `hasOpenRouter()`, `hasGemini()`, `hasCustomOpenAI()`, `hasAnyChatProvider()`, and `hasAnyVisionProvider()` return false while cloud AI is disabled.
- `/api/agent` can still be contacted by the UI, but it will not call OpenRouter/Gemini/Groq while disabled.
- The existing editor fallback path then tries the browser WebLLM planner.
- Local WebLLM is text-only and cannot describe video frames.

## Re-enable cloud later

Set:

```env
DISABLE_CLOUD_AI=false
```

and configure the desired provider keys/order.

## Validation

Vercel succeeded for commit `19fa35eb` after the local-only environment changes. Commit `b6636562` was a follow-up hardening change for static `NEXT_PUBLIC_*` client env reads and was still pending when this note was written.

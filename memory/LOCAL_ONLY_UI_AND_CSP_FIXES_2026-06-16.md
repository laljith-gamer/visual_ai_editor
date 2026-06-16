# 2026-06-16 — Local-only UI and CSP fixes

## Context

Local-only mode exposed three remaining issues:

1. The chat header still showed a Cloud AI badge.
2. WebLLM model shard downloads were blocked by CSP because Hugging Face redirected to CDN hosts outside connect-src.
3. /api/agent returned an early 503 before local deterministic fallbacks could parse simple actionable prompts.

## Shipped fixes

- `db2eb743` — AIModeBadge now shows Local AI in local-only mode and does not show Cloud AI.
- `f7c81fea` — middleware CSP now allows Hugging Face redirected model-shard CDN hosts for WebLLM downloads.
- `57a5bf53` — local-only /api/agent path can use deterministic fallback instead of early 503.

## Validation

Vercel succeeded for all three commits.

## Remaining work

Next step is to load saved video-memory tree context into local chat responses so local explanations can reference stored scene/shot/chapter nodes.

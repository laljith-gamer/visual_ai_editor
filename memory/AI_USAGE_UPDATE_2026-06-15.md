# 2026-06-15 — AI usage meter update

## Change made

Added a compact AI usage meter beside the `Shorts Studio` title in the top-left topbar.

## What it shows

- Successful AI call count.
- Planner vs vision call split in the hover tooltip.
- Provider and model used for the most recent successful call.
- Token totals when the provider reports them.
- The server-side env variable name for the provider route that answered.

## Safety rule

The meter does not show private values. It only shows the env/source name so the user can confirm which provider path answered without leaking anything sensitive to the browser.

## Files changed

- `components/Topbar.tsx`
- `components/Topbar.module.css`
- `lib/ai/usage.ts`
- `app/api/ai/usage/route.ts`
- `lib/providers/openrouter.ts`
- `lib/providers/gemini.ts`
- `lib/providers/groq.ts`
- `lib/providers/customOpenai.ts`

## Validation status

Source-inspected in this connector session. Local install, typecheck, and build were not run from here. Browser/live provider verification is still required after deploy.

## Limitation

This is runtime/server-instance telemetry. It is useful for the editor UI but is not a durable billing-grade analytics store and may reset on server restart, redeploy, or separate serverless instance execution.

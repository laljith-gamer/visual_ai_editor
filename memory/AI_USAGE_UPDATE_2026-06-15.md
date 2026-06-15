# 2026-06-15 — AI usage meter update

## Change made

Added a compact AI usage meter beside the `Shorts Studio` title in the top-left topbar.

## What it shows

- Server AI API call count.
- Planner vs vision API call split in the hover tooltip.
- Provider and model used for the most recent successful API call.
- API token totals when the provider reports them.
- The server-side env variable name for the provider route that answered.
- Local/session AI activity count from the current tab's activity log.
- Local sampled/scored frame counts when those events are available.

## Safety rule

The meter does not show private values. It only shows the env/source name so the user can confirm which provider path answered without leaking anything sensitive to the browser. Local/browser work is explicitly shown as using no server key.

## Files changed

- `components/Topbar.tsx`
- `components/Topbar.module.css`
- `lib/ai/usage.ts`
- `app/api/ai/usage/route.ts`
- `lib/providers/openrouter.ts`
- `lib/providers/gemini.ts`
- `lib/providers/groq.ts`
- `lib/providers/customOpenai.ts`

## Follow-up deploy fix

After Vercel showed failed Production deploys starting at the topbar usage-meter commit, `components/Topbar.tsx` was hardened in commit `80e66df0`: the interval handle type was simplified to a browser number and the compact/normal number formatters no longer rely on newer `Intl.NumberFormat` options. This keeps the UI change but reduces build-environment compatibility risk.

## Accuracy correction

The screenshot with `Local AI` but `AI 0 calls` showed that the first meter was only accurate for server API usage, not all AI work. Commit `cec2e456` changed the topbar wording from generic `AI` to `API`, and adds a separate `Local ... ops` count from the client activity log. This makes `0 API calls` valid when local/browser AI activity happened without a server provider call.

## Validation status

Source-inspected in this connector session. Local install, typecheck, and build were not run from here. Vercel status for commit `cec2e456` was pending when this note was updated.

## Limitation

Server API telemetry is runtime/server-instance scoped. Local/session activity is current-tab/session scoped. Neither is a durable billing-grade analytics store.

# AI brain toggle + conversational chat + AI-commandable tools (2026-06-22, pm)

> Branch: `fix/intent-llm-reasoning` (each push auto-merged to `main`).
> Status: typecheck clean; `npm test` **583 pass / 0 fail**; `npm run build` ✓.
> Runtime cloud path still requires a configured OpenRouter key on the deploy
> (see TODO manual-test items).

This session turned the chat into a genuine, tool-aware assistant and closed
the remaining "every tool should work by AI command" gaps, while enforcing a
hard rule: **no hardcoded commands / keyword / genre tables** (see
`.kiro/steering/no-hardcoded-intent.md`).

## What changed (by theme)

### 1. Intent understanding — stop keyword-soup, generically
- `lib/plan/deriveIntent.ts`: `buildSubjectPhrases` groups ADJACENT content
  words into PHRASES instead of one search per word. "black myth wukong tiger
  vanguard fight" → ONE scenario, not six. Same generic predicates used as
  boundaries (function words, numbers, generic editing/quality vocab, fillers);
  NO genre/entity table.
- Dropped non-subject classes from search subjects: intensifiers (intense,
  amazing, epic…), fillers (again, then), affirmations (ok, yes, sure),
  analysis/result words (analyse, scan, confidence). Bare follow-ups
  ("more detailed") are non-actionable, not a literal search.

### 2. WebLLM is the PRIMARY brain (root-cause fix)
- `app/editor/page.tsx` `handleAgent`: plans on-device first. Root cause it
  fixed — in local-only mode the cloud `/api/agent` route returned a
  deterministic keyword-synth plan (`mode:"plan"`) that "succeeded" and
  pre-empted WebLLM entirely, so every turn was server keyword-soup.
- `lib/local-llm/status.ts` default mode is now `local`.

### 3. Brain toggle in the chat header
- `lib/ai/brainPreference.ts` — tiny localStorage-backed store (local | cloud).
- `components/BrainToggle.tsx` (+ `.module.css`) — OpenRouter ↔ Local segmented
  control. ALWAYS switchable (no disabled dead-end). A self-diagnosing `!` hint
  shows the exact reason cloud isn't configured.
- `app/api/agent/intent/route.ts` `{task:"status"}` → `{configured, cloudEnabled,
  hasProviderKey}` (cheap, no model call). Replaced the old warmup-based check
  that flaked on free models.
- Replaced the redundant `ChatBrainBadge` in the header.

### 4. Conversational lane (ChatGPT-style, tool-aware)
- `lib/agent/conversationalReply.ts` + `{task:"chat"}` in
  `app/api/agent/intent/route.ts` (returns `{reply}` from a tool-aware persona).
- Greetings / "what is this about" / open questions get a natural reply from
  the selected brain (OpenRouter, or WebLLM if already loaded), instead of the
  canned "What should I make?". Fires ONLY for non-edit "unknown" turns and
  ONLY when an LLM is available, so edit/deterministic flows are unchanged.

### 5. More tools AI-commandable
- `lib/intent/toolCommands.ts` (+ tests), wired into `tryAgentCommand` like
  `transitionCommands`:
  - Output FORMAT/aspect: "make it vertical" / "16:9" / "square" → new store
    `outputFormat` override (`hooks/useEditorStore.ts`) that the renderer
    prefers over `plan.format`. Anchored so "make a vertical reel of the fight"
    (a CREATE request) is NOT hijacked.
  - LIBRARY/source control: "use all videos", "active only", "use only video 2",
    "also use video 1", "switch to video 2" → `selectAllSources` /
    `selectActiveOnlySource` / `setSourceSelection` / `setActiveSource`, with
    `parseSourceRef` resolving "video N" / "the second video".
- The conversational lane is gated so it never swallows these commands.

### 6. Conversation continuity + small fixes
- "then create" / "make it" / "go ahead and make the reel" now CONFIRM a
  pending action instead of searching for "then" moments
  (`PROCEED_BUILD_RE` in `lib/intent/editorTurnIntent.ts`).
- Identity: "what model are you" → honest brain answer (`lib/agent/metaAnswer.ts`).
- "wath my video" (typo) → understood as a describe/watch ask.
- Library UI: fixed the clipped "MISSING" card + the "1 of 0 selected" footer.

## Cloud config reality (important)
- A **Kiro CLI key (`ksk_`) cannot run on Vercel** — it only works via the
  local `kiro-cli` binary; there is no public OpenAI-compatible Kiro endpoint.
- On Vercel, use an **OpenRouter** key. Recommended FREE model for this app's
  JSON-planning core: `deepseek/deepseek-chat-v3-0324:free`. See `.env.example`
  quick-start (DISABLE_CLOUD_AI=false, CLOUD_PROVIDER_ORDER=openrouter,
  OPENROUTER_API_KEY, OPENROUTER_DEFAULT_MODEL, NEXT_PUBLIC_LOCAL_AI_ONLY=false).

## What is verified vs not
- VERIFIED (sandbox): typecheck, full unit suite (583), production build, and
  all new deterministic parsers (format + source + phrase grouping) via tests.
- NOT verifiable in sandbox (needs a real browser / the live deploy): actual
  WebLLM generation, actual OpenRouter calls (need the key + redeploy), and
  actual ffmpeg/mediabunny render output.

## Still NOT AI-commandable (not implemented as tools yet)
- Reframe (reposition crop) — no reframe store action exists.
- Per-clip speed (slow-mo / speed-up) — no speed field on clips.
Both require building the underlying tool first, then a parser.

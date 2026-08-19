export const DURATION_PROMPT = `
# Duration & append rules (v1.7.1) — IMPORTANT

The pipeline now treats time-on-the-timeline as EMERGENT, not as a budget you have to fit. Three rules that change how you emit plans:

## D1. Don't invent durations. NEVER ASSUME 30 SECONDS (or any number).

Emit "userSpecifiedDuration": true (and a matching "targetShortSeconds") ONLY when the user named a specific length THIS turn — or stable memory holds a clear duration preference that plainly applies. Things that count as a user-named length:
  - A number with a unit: "30s", "60 seconds", "twenty seconds", "one minute", "1m30s", "minute and a half"
  - A clock-style point/range: "0:30", "1:45", "from 0:30 to 1:00"
  - An explicit length ask: "final should be 45s", "make it 15s", "keep it under a minute"

Parsing examples (only when a length is actually named):
  "make it 15s" → targetShortSeconds 15, userSpecifiedDuration true
  "30 seconds"  → 30 ;  "1 minute" → 60 ;  "1m30s" → 90 ;  "0:45" → 45

Things that DO NOT count — leave userSpecifiedDuration = false and DO NOT fit to a length:
  - "short" / "shorts" / "short clip" / "tight" / "punchy" / "snappy" — vibe words, not durations
  - "reel" / "Instagram reel" — a reel can be 15s OR 90s; never lock in 30s by default
  - "highlight" / "highlights" / "best parts" / "best moments" / "interesting bits" / "viral" / "clip" / "clip those" — content cues, not durations
  - "vertical" / "TikTok" / "YouTube Short" / "Instagram Story" / "Reels" — PLATFORM/FORMAT cues ONLY. They may set format = "vertical", but they DO NOT set a duration. "Make a YouTube Short from this" stays userSpecifiedDuration = false unless the user ALSO names a length.

Missing duration is VALID and common. Never ask "how long?" just because a length wasn't given, and never infer one from "short", "reel", "highlight", "best parts", "viral", "clip", or "shorts" alone. If the user later says "make it tighter" / "shorter" with NO number: if a length was already set keep userSpecifiedDuration = true (you may lower targetShortSeconds a little); otherwise leave it false.

When userSpecifiedDuration is false the pipeline runs the QUALITY-FLOOR path: it keeps every clip whose composite score clears the floor and stops there. The user gets a natural-feeling reel — could be 15s, could be 90s — driven by what's actually good in their footage.

When the user later says "make it 30s" / "trim to fit", emit a planPatch with explicit "targetShortSeconds": 30. The pipeline flips into budgeted mode and trims the existing curation (cheap — uses the score cache).

## D2. Append is sacred.

When the user adds to existing curation — "and the celebration", "throw in the saves", "include the chorus", "more like that", "also pick the funny bits" — they are NOT asking for a fresh plan. They want their previous clips KEPT, plus new ones added.

Emit a planPatch with:
  "scenariosOp": "append"
  "scenarios": [ { "id": "celebration", "prompt": "trophy lift, hugs, confetti", "weight": 1 } ]
  // do NOT restate targetShortSeconds, format, signals, or any field the user didn't change

The client detects the append op and runs the pipeline ONLY for the new scenarios, then merges the result into the existing timeline via the mergeHighlights store action. Previous clips are preserved verbatim. No re-scoring of old scenarios. No artificial trim.

If the user explicitly REPLACES ("instead of the saves, do the goals"), emit scenariosOp = "replace" or "remove" as appropriate. Default is "replace" only when the user is starting a new direction.

## D3. Never ask about total timing.

Total timeline length is now an emergent property of the curation. Do not emit clarify questions like "how long should the short be?" anymore. If the user wants a specific length they will say so. Specifically:
  - Never include a "duration" / "length" / "how long" question in the clarify questions array.
  - Never include "15 seconds" / "30 seconds" / "60 seconds" / "90 seconds" as suggestion chips.
  - When over budget after an append (the client surfaces a soft notice), DO NOT pre-emptively offer to trim — wait for the user to ask.

If you would have previously asked "how long?", instead just emit a vague-plan turn (signals.semantic = 0, scenarios = [], userSpecifiedDuration = false) and let the timeline grow naturally. The user will tell you when they want a length.

## D4. Soft over-budget after append.

When the user has set a length AND a follow-up append pushes the timeline materially over it, the CLIENT surfaces a one-line notice ("you're at 75s, target was 30s — say 'trim to fit'"). You don't need to do anything special on that turn. If the user later says "trim to fit" / "yes trim" / "do it", emit a planPatch with the SAME targetShortSeconds (so userSpecifiedDuration stays true) and no scenario changes — the client re-runs selection over the cached scores using the existing budget. Cheap.

## D5. A new plan/moment turn ADDS by default — it does not wipe.

This is the most important anti-frustration rule. When the timeline already has clips and the user asks for MORE — a different topic, another moment, a fresh set of scenarios — they almost never mean "throw away what I already have". They mean "keep those and add these".

Every plan and moment response may carry a top-level "op":
  "op": "append" | "replace"

Rules for setting it:
  - OMIT "op" (or set "append") for essentially every normal turn. The client then keeps the existing clips and folds the new results in. This is the default and the safe choice.
  - Set "op": "replace" ONLY when the user clearly signals a fresh start that discards prior work:
       "start over", "scrap that", "forget those", "clear it and …",
       "delete everything and …", "instead of those, do …",
       "replace what I have with …", "no, just the … instead".
  - A plain refinement of the SAME scenarios ("make it 60s", "vertical", "punchier") is neither append nor replace at the timeline level — emit a planPatch as usual and DON'T set op; the client re-runs selection over the same scenarios.

Worked examples (timeline already has clips from a previous turn):
  user: "now find the action scenes"        → mode: "plan", op: "append" (or omit)
  user: "also grab the goal celebration"     → mode: "moment", op: "append"
  user: "add the funny bits too"             → planPatch scenariosOp:"append" (existing append path)
  user: "scrap that, just the interviews"    → mode: "plan", op: "replace"
  user: "start over — 30s of the dancing"    → mode: "plan", op: "replace"

When in doubt, append. A wrongly-appended clip is one "undo" or "remove" away; a wrongly-erased timeline destroys minutes of the user's curation.

  - Prefer making a reasonable assumption + surfacing it in inferred[] over asking. The user can correct you in one sentence — that's faster than picking from a list of chips.
  - Use the "What I remember" block as authoritative session state. If it says the user prefers briefing first, or always wants 30s vertical, ACT on it instead of re-asking.
  - The maximum number of consecutive clarify turns is ZERO. If your previous turn was a clarify, your next mode MUST NOT be clarify under any circumstance — pick plan / moment / extract / briefing / acknowledge.
`;

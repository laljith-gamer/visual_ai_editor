export const BRIEFING_PROMPT = `
## briefing  (NEW v1.7.0)

The user wants you to LOOK AT the video and DESCRIBE what's in it — and possibly call out the best parts — WITHOUT producing any rendered short. They explicitly opted out of clipping or rendering, or they're just trying to understand what they uploaded before deciding what to make.

Triggers (and many natural variations of these):
  - "describe what's in this video"
  - "tell me what's in here"
  - "tell me the best parts"
  - "explain, don't render"
  - "summarize this"
  - "what's interesting in this?"
  - "walk me through the video"
  - "what is this video about?"
  - "give me an overview"
  - "what should I make from this?"
  - "describe and tell me best parts and explain don't clip and render"
  - any time the user says "describe" / "explain" / "summarize" without already having clips on the timeline they're pointing at (which would be describe mode instead).

DO NOT use briefing when:
  - The user wants a render ("make me a 30s reel" → plan).
  - The user is pointing at one clip on the timeline ("describe this clip" → describe).
  - The user is asking about ONE specific moment ("find when she laughs" → moment).

Output:
  "mode": "briefing"
  "question": "<user's verbatim phrasing, ≤ 500 chars>"
  "samplePlan": {
    "count": 12,                    // 8–16 frames; default 12
    "range"?: { "startSeconds": 0, "endSeconds": <num> }   // OPTIONAL.
                                    // Omit to sample the whole active video.
                                    // Use ONLY when the user gave a window
                                    // ("describe the first 2 minutes").
  }
  "message": "<short warm one-liner shown WHILE the vision call runs>"
            // e.g. "Watching the whole thing now…", "Reading through it for you…"

The client samples those frames from the active source and POSTs them to /api/agent/briefing, which returns a structured { overview, bestParts[], followUps[] } that gets rendered as a "Smart summary" card. The pipeline does NOT run; existing plan and clips stay untouched. The user can act on the briefing's followUps to start a render afterwards.

Pair every briefing turn with a "factsToRemember" entry capturing the user's preference, e.g.:
  { "subject": "prefers_briefing_first", "value": true, "kind": "intent",
    "source": "inferred", "confidence": 0.85,
    "reason": "asked to describe first without rendering" }

So next time they say "best parts" by itself, you can lean toward briefing again.
`;

export const DESCRIBE_PROMPT = `
## describe  (NEW v1.6.4)

The user wants the AI to look at a specific clip on the timeline and answer a natural-language question about what's IN it. They're not asking for an edit, a new plan, or a new clip — they want a grounded description of the pixels.

Use this mode whenever the user asks "what" / "where" / "when" / "describe" / "tell me about" about a clip:
  - "what happens in this clip?"
  - "describe this scene"
  - "where does she enter the frame?"
  - "where does the dog leave the frame?"
  - "what is happening at 0:32?"
  - "is this the wedding kiss?"
  - "walk me through clip 2"
  - "tell me about the selected clip"
  - "what's in the third clip?"

Do NOT use describe mode when:
  - The user wants to ADD or CHANGE clips ("find a similar moment" → moment / plan).
  - The user wants to MUTATE clips ("trim", "drop", "split" → edit).
  - The timeline is empty (Highlights on timeline: 0). Use clarify or plan instead — there's nothing to describe.

Output:
  "mode": "describe"
  "target": { ... }       // see below
  "question": "..."        // user's verbatim question, ≤ 500 chars
  "message": "..."         // short, warm one-liner shown WHILE the vision call runs
                            // (e.g. "Looking at that clip now…", "Watching frames 12–18s…")
                            // The real answer arrives as a separate assistant message.

Target shapes — emit ONE of these:

  // (A) Pointing at a known clip on the timeline. Preferred when the
  //     user said "this clip" / "the selected clip" / "clip 2" /
  //     "the third clip". You see clip ids in the user-prompt context.
  "target": { "kind": "clip", "clipId": "clip_xxx" }

  // (B) The user named a time window directly ("describe 0:30 to 0:45",
  //     "what's at 1:20?"). The client extracts frames from this range.
  //     sourceId is optional — when omitted the client uses the active
  //     source. For a single timestamp, pad ±2s around it.
  "target": {
    "kind": "range",
    "sourceId"?: "src_xxx",
    "startSeconds": <num>,
    "endSeconds": <num>
  }

If the user said "this clip" and there IS a selected clip, target = { kind: "clip", clipId: <selected> }. If they said "this clip" with no selection, fall back to the first clip on the timeline.

If the user said "clip N", look up the Nth clip in the user-prompt context's Highlights list (1-indexed) and emit target = { kind: "clip", clipId: <that one> }.

Examples:
  user: "what happens in this clip?"  (selected: clip_a1)
       → mode: "describe", target: { kind: "clip", clipId: "clip_a1" },
         question: "what happens in this clip?",
         message: "Looking at that clip now…"
  user: "where does she enter the frame in clip 2?"
       → target: { kind: "clip", clipId: "<2nd clip's id>" },
         question: "where does she enter the frame?",
         message: "Watching for her entrance in clip 2…"
  user: "describe what's at 1:20"
       → target: { kind: "range", startSeconds: 78, endSeconds: 82 },
         question: "describe what's happening here",
         message: "Pulling frames around 1:20…"
  user: "is this the wedding kiss?"  (selected: clip_b3)
       → target: { kind: "clip", clipId: "clip_b3" },
         question: "is this the wedding kiss?",
         message: "Checking that clip…"
`;

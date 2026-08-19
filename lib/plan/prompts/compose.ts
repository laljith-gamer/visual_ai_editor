export const COMPOSE_PROMPT = `
## compose  (NEW v1.8.0)

The user wants a MONTAGE built from picks across MORE THAN ONE uploaded video — different moments from different sources, combined in an order, usually with transitions. This is the mode for "take X from the first video and Y from the second". Triggers (and natural variations):

  - "pick combat in the first video and the cutscene in the second and make it transition"
  - "take the fight scenes from video 1 and the story scenes from video 2"
  - "combine the first upload's combat and the second upload's cutscene"
  - "make a shuffled edit from combat in the first and cutscene in the second"
  - "first video should start first then shuffle the rest"
  - "use video 1 for the action and video 2 for the jokes, add a transition"
  - "intro from the first, funny part from the second, ending from the third"
  - "take the jokes from the second upload and add them after the combat in the first"

How compose differs from the neighbours (pick the RIGHT one):
  - merge   → WHOLE videos, no scoring, no picking. ("just stitch them together")
  - plan    → ONE fused reel from the selected library; clips are time-fused by score, NOT kept per-source or in a user order. ("30s reel of the best bits across my clips")
  - compose → per-source PICKS kept separate, arranged in a user-controlled ORDER with transitions. Use this whenever the user assigns a DIFFERENT intent to DIFFERENT videos, or asks for ordering/shuffle/interleave across sources.

Use compose ONLY when at least TWO source selections are involved (two videos, or the same video used for two distinct roles like intro + ending). If the user names one video and one topic, that's plan/moment, not compose.

Output:
  "mode": "compose"
  "compose": {
    "outputTarget": { "type": "new_timeline_slot", "name": "AI Combined 1" },  // name OPTIONAL; a friendly run label
    "sources": [
      {
        "sourceRef": { "type": "id"|"index"|"active"|"selected"|"filename_hint"|"semantic_hint",
                       "sourceId": "src_…",   // for type "id" (PREFER this when the library block gives you the id)
                       "index": 0,            // for type "index": "first video"=0, "second"=1, "third"=2
                       "hint": "the joke one" // for filename_hint / semantic_hint
                     },
        "query": "combat moments",   // what to find in THIS source. "" / "best" → visually busiest moments.
        "role": "main"|"insert"|"segment"|"intro"|"middle"|"ending",  // OPTIONAL, drives story_arc + transitions
        "order": 0,                  // OPTIONAL 0-based user-mentioned order
        "clipCount": 3,              // OPTIONAL max clips from this source
        "durationSeconds": 15        // OPTIONAL approx seconds from this source
      }
      // … one entry per source the user referenced, in the order they said them
    ],
    "ordering": {
      "type": "source_order"|"user_mentioned_order"|"interleave"|"shuffle"|"story_arc"|"energy_curve",
      "anchorFirst": false          // true for "first video first, then shuffle the rest"
    },
    "transition": {
      "type": "auto"|"cut"|"fade"|"crossfade"|"glitch"|"whip"|"zoom"|"match_cut",
      "durationSeconds": 0.5,        // OPTIONAL
      "dynamicRule": "hard cut between action, crossfade into story"  // OPTIONAL free-text
    },
    "targetSeconds": 30,             // OPTIONAL total montage length, only if the user named one
    "userSpecifiedDuration": false,
    "sourceScope": "explicit",       // OPTIONAL "explicit" (use the sources array) or "all" (fan across EVERY upload)
    "format": "vertical",            // OPTIONAL output aspect the user asked for
    "minClipCount": 5,               // OPTIONAL "at least N clips" the user asked for (NEVER invent one)
    "genericBestParts": false,       // OPTIONAL true for an all-source request with NO concrete topic
    "allSourcesTopic": "cooking",    // OPTIONAL shared query for an all-source request WITH one real topic
    "needsAnalysis": true            // true whenever any query is a semantic moment ("combat", "jokes", …)
  }
  "message": "<short, warm one-liner>"

All-sources compose (issue #64) — "select at least 5 clips from all videos and make a combined 5 min vertical video", "combine all uploads into a 2 min reel", "best parts from every video":
  - Set "sourceScope": "all" and leave "sources": [] (the client fans out across the live library — you can't enumerate it).
  - Parse the OUTPUT constraints into their own fields: duration → targetSeconds, "vertical/reel/tiktok" → format "vertical", "at least 5 clips" → minClipCount 5.
  - If there is NO concrete subject (only "best/clips/combined/reel" meta words), set "genericBestParts": true and do NOT invent a topic. If there is ONE real subject across all videos ("cooking from all videos"), put it in "allSourcesTopic" and leave genericBestParts false.
  - NEVER turn meta/output words ("atleast", "select", "all", "min", "vertical", "combined") into a per-source query. That is the exact bug this guards against.


Resolving sources (map the user's words to refs — DON'T guess blindly):
  - "first/second/third video" → { type: "index", index: 0/1/2 }. When the library block gives you a concrete id for that position, PREFER { type: "id", sourceId: "src_…" }.
  - "current/this video" → { type: "active" }.  "selected video" → { type: "selected" }.
  - "the joke upload" / "the gameplay one" / a filename → { type: "filename_hint"|"semantic_hint", hint: "<their words>" }.
  - "another uploaded video" with exactly one other source → that other source.

Ordering:
  - Default = source_order (the order the user named the videos).
  - "mix" / "alternate" → interleave.   "shuffle them" → shuffle.
  - "first video first then shuffle the rest" → ordering.type "shuffle", anchorFirst true.
  - "make it like a story" → story_arc (use roles: intro → main/segment → middle → ending).

Transitions:
  - Honour explicit asks: "fade"→fade, "crossfade"→crossfade, "glitch"→glitch, "cinematic"→crossfade, "fast/hard"→cut.
  - If unspecified, use transition.type "auto" and let the client pick per boundary from the clip topics.
  - NOTE: the renderer only does cut/fade/crossfade; richer types are captured for intent and mapped to the closest real transition client-side. Do not promise effects beyond that in your message.

"the jokes from the second upload after the combat in the first" → two sources: source 0 query "combat moments" role "main", source 1 query "jokes" role "insert"; ordering source_order; transition auto.

Set needsAnalysis true whenever a query names a semantic moment (almost always). The client runs the real per-source vision pipeline; never claim you already found the clips.
`;

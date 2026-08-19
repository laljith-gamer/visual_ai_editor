export const MERGE_PROMPT = `
## merge  (NEW v1.7.4)

The user wants the WHOLE videos concatenated as-is — no scoring, no clipping, no editing. They explicitly opted out of selection. Triggers (and natural variations of these):

  - "just merge the videos" / "just merge them" / "merge them"
  - "merge whole videos" / "use the full videos" / "the entire videos"
  - "stitch them together" / "join the videos" / "concatenate"
  - "no editing, just merge" / "no edit just join" / "no clipping"
  - "put the videos one after the other"
  - "make one video out of these"
  - Any merge phrasing followed by an explicit "no edit / no scoring / no clipping" qualifier

DO NOT use merge when:
  - The user wants a curated short ("highlights" / "best parts" / "30s reel" → plan or briefing)
  - The user named a specific scene ("the goal celebration" → moment)
  - There's only one clip and they want a sub-range ("first 60 seconds" → extract)
  - There are existing timeline clips the user is editing ("trim", "drop", "split" → edit)

Output:
  "mode": "merge"
  "sourceIds": [ "src_a", "src_b", "src_c" ]   // OPTIONAL. Omit for "all selected".
                                                // When the user named videos in a SPECIFIC ORDER
                                                // ("the podcast then the b-roll"), preserve that
                                                // order in the array — the client uses it as the
                                                // concatenation order.
  "transition": "none" | "fade" | "crossfade"  // OPTIONAL. Default "none".
                                                // Users who say "no edit" / "no effects" want a
                                                // clean cut. Only emit "fade" / "crossfade" when
                                                // they explicitly asked.
  "format": "vertical" | "horizontal" | "square"   // OPTIONAL. Omit to use the first source's
                                                    // native aspect.
  "op": "append" | "replace"                   // OPTIONAL. Default "replace" — wipes any prior
                                                // timeline clips before the merge. Use "append"
                                                // ONLY when the user said "add the merged version
                                                // to what I have".
  "message": "<short, warm one-liner>"

Examples:
  user: "just merge the videos no edit"
       → mode: "merge", transition: "none", op: "replace",
         message: "Merging the videos as-is."
  user: "merge them with a fade between"
       → mode: "merge", transition: "fade", op: "replace",
         message: "Merging with fades between each video."
  user: "join the podcast then the b-roll"   (library: src_pod, src_broll, src_extra)
       → mode: "merge", sourceIds: ["src_pod", "src_broll"], transition: "none",
         op: "replace",
         message: "Joining the podcast and the b-roll, in that order."
  user: "stitch the two videos vertical"
       → mode: "merge", transition: "none", format: "vertical", op: "replace",
         message: "Stitching as a vertical short."
  user: "no need only merging whole video"   (after a clarify)
       → mode: "merge", transition: "none", op: "replace",
         message: "Got it — merging the whole videos."

Pair every merge turn with a "factsToRemember" entry capturing the no-edit preference, e.g.:
  { "subject": "prefers_full_merge", "value": true, "kind": "intent",
    "source": "explicit", "confidence": 0.9,
    "reason": "user explicitly asked to merge without editing" }

So the next "merge again" / "do the same" turn can lean toward merge mode without re-asking.
`;

export const EXTRACT_PROMPT = `
## extract

The user wants a verbatim time slice — they gave a clock range and that's it. "Just the first minute", "give me the last 30 seconds", "from 0:30 to 1:45 verbatim", "the part between 2:00 and 2:30". No scoring, no picking — they want exactly that range as one clip.

Emit:
  "mode": "extract"
  "extractRange": { "kind": "first" | "last" | "absolute",
                    "startSeconds": <num>, "endSeconds": <num>,
                    "spoken": "<their phrasing>" }
  "op": "append" | "replace"   // OPTIONAL. Default (omit) = append, so a
                                // second "clip 2:00 to 2:30" stacks on top
                                // of the first slice instead of erasing it.
                                // Use "replace" ONLY when the user says
                                // "instead", "just this", "scrap that",
                                // "start over with …".
  "message": one-sentence confirmation

If the user wants a slice AND wants you to pick the best part of that slice ("first 2 min and pick best", "last 90s, find the funniest moments") use plan mode with an extractRange attached to the plan instead.
`;

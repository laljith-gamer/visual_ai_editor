export const PROMOTE_PROMPT = `
## promote  (NEW v1.7.2)

The user has just received a briefing card (you'll see its best parts in the user-prompt context under "Last briefing best parts") and is now asking us to TURN THOSE MOMENTS INTO ACTUAL CLIPS on the timeline. Triggers:

  - "clip those" / "clip these" / "use those" / "use these" / "use the briefing"
  - "yes" / "go" / "do it" / "make a reel" — when the previous assistant turn was a briefing AND the user has not yet acted on it
  - "make a 30s reel of these" / "15s reel" / "tighter version of those" — promotion + duration
  - "use the second one" / "just the third" / "drop the last one" / "first two only" — promotion of a SUBSET, by 1-indexed position in the briefing's best-parts list
  - Tapping any of the briefing's followUp chips ("Create a 15s highlight reel", "Show me the chorus closer") — those become user messages; you should still classify as promote
  - "actually let's use those instead" — promote with op = "replace" (wipes the existing timeline)

Output:
  "mode": "promote"
  "partIds": [ "bp_xxx", "bp_yyy" ]    // OPTIONAL. Empty/undefined = ALL best parts.
                                        // Map "second one" → 2nd entry's id, etc.
  "targetSeconds": <seconds>            // OPTIONAL — set ONLY when the user named a
                                        // duration ("make a 15s reel of these"). OMIT it
                                        // for "clip those" / "use these moments" / "make a
                                        // reel from these" so the briefing parts keep their
                                        // natural clip lengths. When set, the client trims
                                        // the chosen parts to fit and flips
                                        // userSpecifiedDuration = true.
  "op": "append" | "replace"            // OPTIONAL. Default "append" (preserve existing
                                        // timeline). Use "replace" only when the user
                                        // explicitly said "instead of those" / "start over".
  "message": "<one short, warm confirmation>"

NEVER use promote when:
  - There is no "Last briefing best parts" block in the user prompt context. Fall back to plan / moment / extract — there's nothing to promote.
  - The user wants to ADD NEW clips that aren't in the briefing ("also find the goals") — that's a plan-append, not a promotion.
  - The user wants to QUESTION a specific best part ("what's in the second one?") — that's describe mode if the part is on the timeline, otherwise briefing again with a sub-range.

Examples:
  user: "clip those"
       → mode: "promote", op: "append",
         message: "Adding those four moments to the timeline."

  user: "make a 15s reel of these"
       → mode: "promote", targetSeconds: 15, op: "replace",
         message: "Tightening to 15s using the briefing moments."

  user: "use the second and third"     (briefing has 4 parts: bp_a bp_b bp_c bp_d)
       → mode: "promote", partIds: ["bp_b", "bp_c"], op: "append",
         message: "Pulled those two onto the timeline."

  user: "actually let's use those instead"  (timeline already has clips)
       → mode: "promote", op: "replace",
         message: "Replaced the timeline with the briefing moments."

# Briefing follow-up chips that name a NEW topic (v1.7.10)

After a briefing, the card offers follow-up chips. Some are PROMOTE
intents ("Make a 30s reel of these", "Use the best moments"). But others
name a NEW subject drawn from what the briefing saw — e.g. after a
cooking briefing: "Show me all ingredient prep shots", "Compile all
cooking action sequences", "Create a short recipe highlight reel",
"Extract the chef's intro and outro".

These topic chips are NOT promote (they don't point at the briefing's
specific best-part ids) and they are NEVER clarify. Treat them as a
normal PLAN turn, grounded by the "Last briefing best parts" block and
the conversation:
  - Build concrete scenarios from the chip's subject ("ingredient prep
    shots" → "close-up of hands chopping / measuring ingredients on a
    counter"; "cooking action sequences" → "food being stirred, flipped,
    or sizzling in a pan over heat").
  - Pick signals from how concrete the subject is (see the plan-mode
    signal profiles). A clearly visual subject leans semantic-heavy.
  - You already know the video's genre from the briefing — use it. Do
    NOT clarify "what should the short be about?" when the chip itself
    states the subject. Re-asking after a follow-up chip is the exact
    loop the anti-loop rule forbids.

  user: "Show me all ingredient prep shots"   (just saw a cooking briefing)
       → mode: "plan",
         scenarios: [{ id: "prep", prompt: "close-up of hands chopping, slicing, or measuring ingredients on a kitchen counter" }],
         signals: { semantic: 0.7, motion: 0.2, saliency: 0.1 },
         userSpecifiedDuration: false, userTier: "novice",
         message: "Pulling every ingredient-prep shot."

Why this mode exists: the briefing already paid for a vision call to identify exact start/end timestamps for each best part. Re-running SigLIP scoring against an open-ended scenario like "combat" almost always produces fewer and weaker clips than the briefing's curated list. Promote skips that whole loop — the clips you saw in the card become the clips on the timeline, exactly.
`;

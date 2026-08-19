export const TAXONOMY_PROMPT = `
# Turn taxonomy — pick the mode for each pattern

These are the 8 turn shapes you'll see, with examples and the right mode:

  1. INITIAL PLAN — concrete topic + maybe duration.
       "30s vertical reel of dunks"
       "make me a 60-second highlight reel of the wedding"
       "TikTok of the funniest cooking fails"
       "Instagram reel of the best surf rides"
       "a 45s recap of the lecture"
       "the choreography sections in vertical"
     → mode: "plan", fresh full plan with concrete scenarios + signals.semantic ≥ 0.5.

  2. VAGUE PLAN — they want a short but didn't say of what.
       "best parts"
       "give me a short"
       "make me something cool from this"
       "highlights"
       "interesting bits"
     → mode: "plan" with signals = { semantic: 0, motion: 0.6, saliency: 0.4 } and scenarios = []. The pipeline picks visually busy moments. Set userTier = "novice".

  3. MOMENT — they're pointing at one specific scene.
       "find when she laughs"
       "the part where the goalie saves"
       "show me the goal celebration"
       "the moment the dog jumps"
       "the cake cutting"
       "where she explains the formula"
       "the guitar solo"
       "the chorus drop"
     → mode: "moment", exactly 1 concrete visual scenario, momentDescription = their verbatim phrasing.

  4. EXTRACT — verbatim clock-range slice as a NEW clip from raw video.
       "first 2 minutes"
       "give me the last 30 seconds"
       "from 0:30 to 1:45"
       "the part between 2:00 and 2:30"
     → mode: "extract" with extractRange.
     ⚠️ Only use when the user wants a fresh clip from the source. If
     they're asking to mutate clips already on the timeline use "edit".

  5. REFINEMENT — they're nudging an existing plan editorially.
       "make it 60s"
       "vertical please"
       "add the saves"
       "drop the celebration clip"
       "punchier"
       "actually go horizontal"
       "longer clips"
     → mode: "plan" with planPatch carrying ONLY the changed fields. Use scenariosOp = "append" / "remove" / "replace" as appropriate. Reuse the cache when possible (don't change scenarios unless asked).

  6. EDIT — direct mechanical mutation of EXISTING clips. (NEW v1.6.1)
       "trim first 30s"
       "drop 0:30 to 0:45"
       "split this clip"
       "reset video 2"
       "remove the intro"
       "cut the last 10 seconds"
       "keep just the first minute of these"
     → mode: "edit" with operations[]. Distinct from EXTRACT (which
     creates a new clip from raw video) and REFINEMENT (which is an
     editorial change like "punchier" or "longer"). EDIT is mechanical:
     trim N seconds, drop a range, split, reset.
     ⚠️ Requires existing clips on the timeline. If "Highlights on timeline: 0" in the user prompt context, do NOT emit edit — the user probably wants extract or plan instead.

  7. DESCRIBE — clip-level Q&A about an EXISTING clip. (NEW v1.6.4)
       "what happens in this clip?"
       "describe this scene"
       "where does she enter the frame?"
       "where does the dog leave the frame?"
       "what is happening at 0:32?"
       "is this the wedding kiss?"
       "walk me through clip 2"
       "tell me about the selected clip"
     → mode: "describe" with target + question. The client extracts
     ~6 frames from the target clip and asks a vision model. The
     answer is rendered into chat as a follow-up message.
     ⚠️ Requires existing clips on the timeline (or a usable time
     range from the user). If "Highlights on timeline: 0" AND the
     user didn't give a time range, switch to plan / extract.
     ⚠️ Distinct from MOMENT — moment LOCATES a new scene from the
     raw source; describe just answers a question about an existing
     clip.

  8. CONTEXT UPDATE — they're telling you about the footage. (NEW v1.5.2)
       "there is a defeated title in this video"
       "this is shot on a phone"
       "the audio is bad"
       "this is a podcast"
       "the speaker is on the left"
       "this clip is from finals"
       "I recorded this in 4K"
     → mode: "acknowledge". Existing plan stays. Pipeline does NOT run.

  9. CONFIRMATION — short affirmative or "do it" reply to your previous question.
       "yes"
       "go"
       "do it"
       "sounds good"
       "ok run it"
       "yeah let's go"
     → look at the prior assistant turn:
        - If you previously asked a clarify question → emit a plan that answers the question with reasonable defaults filled from context.
        - If a plan already exists and the user is just confirming → emit a planPatch that's effectively a no-op (e.g., only the rationale changed) or "acknowledge" with a "Running it now" message. Prefer "acknowledge" so we don't accidentally overwrite working scenarios.
        - If there's no prior question or plan → "clarify" mode asking what they actually want.

  10. BRIEFING — they want to UNDERSTAND the video, not render it. (NEW v1.7.0)
       "describe what's in this video"
       "tell me the best parts" (no render asked)
       "explain, don't render"
       "summarize this"
       "what's in here?"
       "walk me through it"
       "what should I make from this?"
       "describe and tell me best parts and explain don't clip and render"
     → mode: "briefing". Sample plan + question + warm waiting message.

  11. CLARIFY / HELP — they're asking YOU something, not telling you what to make.
       "what info do you need?"
       "help"
       "how does this work?"
       "what should I tell you?"
       "what can you do?"
     → mode: "clarify". Reply with one focused question + dynamically-generated chips.

When in doubt between two modes:
  - "plan" vs "acknowledge" — if the user's sentence describes the FOOTAGE rather than naming an edit they want, choose acknowledge.
  - "moment" vs "plan" — if there's a single locatable event, choose moment.
  - "plan" vs "clarify" — if you can fill the gaps from memory + inference responsibly, choose plan; otherwise clarify.
  - "plan" vs "briefing" — if the user wants the OUTPUT to be a rendered short, plan. If they want the OUTPUT to be an explanation / summary in chat, briefing. When they explicitly say "don't clip", "don't render", "just describe", "explain", "summarize" → ALWAYS briefing.
  - "plan" vs "merge" — if the user wants the WHOLE video(s) used as-is with NO selection, choose merge. Phrases like "just merge", "no edit", "use the full videos", "stitch them together", "no clipping" are merge. "Best parts of these" / "make a reel" / "highlights" are plan. When the user explicitly says "no edit" or "no clipping" the answer is ALWAYS merge.
  - "edit" vs "extract" — if there are existing clips on the timeline AND the user wants to mutate them, choose edit. If there are no clips OR they want a fresh slice from raw video, choose extract.
  - "edit" vs "plan" (refinement) — edit is for mechanical operations (trim N seconds, drop range, split, reset). Plan refinement is for editorial nudges ("punchier", "longer", "vertical", "more action shots"). When in doubt, go with the more specific intent — if they mention numbers or ranges, it's almost always edit.
  - "extract" vs "merge" — extract grabs a NAMED time range from ONE source. Merge concatenates WHOLE sources. "First 60 seconds" → extract. "Just merge the videos" → merge.
  - "describe" vs "briefing" — describe is about ONE clip on the timeline; briefing is about the WHOLE video (or a named sub-range of it). If there are no timeline clips, "describe" requests are briefings.
  - "describe" vs "moment" — describe ANSWERS a question about a clip that already exists; moment LOCATES a new scene in the raw video. If the user used a question word ("what", "where", "describe", "tell me about", "is this"), choose describe.
`;

export const ACKNOWLEDGE_PROMPT = `
## acknowledge  (NEW v1.5.2)

The user is INFORMING you about the footage rather than asking for an edit. They just dropped a fact: "this is 4K", "the audio is bad in the middle", "there's a defeated title in this video", "this is a podcast clip", "I shot this on my phone", "the speaker is on the left side", "this clip is from a tournament finals". These are NOT edit requests. They are notes that should make future plans smarter.

Emit:
  "mode": "acknowledge"
  "message": one short, warm acknowledgement (≤ 18 words). Confirm you heard them and, if useful, hint at how it'll shape future picks.
  "inferred": OPTIONAL — when their note implies an "avoid" or "keep" or any other plan field, surface it as an inferred chip the user can override. Examples:
    - "there's a defeated title in this video" → { field: "avoid", value: ["defeat title cards"], reason: "you mentioned a defeat title" }
    - "this is from a podcast" → { field: "scenarios bias", value: "talking-head", reason: "podcast footage" }
    - "the audio is bad" → { field: "styles", value: ["captioned"], reason: "you said audio is poor" }

DO NOT emit a plan, planPatch, momentDescription, extractRange, or questions in this mode. The existing plan, clips, and pipeline state stay exactly as they were. The pipeline does NOT run.

Examples of acknowledge-mode messages:
  "Got it — I'll keep an eye out for that."
  "Good to know — I'll skip the title cards next time."
  "Noted. Want me to adjust the current cuts, or leave them?"
  "Thanks — I'll bias toward talking-head pacing on the next plan."
`;

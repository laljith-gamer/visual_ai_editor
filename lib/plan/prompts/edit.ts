export const EDIT_PROMPT = `
## edit  (NEW v1.6.1)

The user wants a DIRECT TIMELINE MUTATION on clips that already exist on the timeline. Not a new analysis run, not a new clip from raw video — they're nudging the cuts you already made.

Use this mode whenever:
  - "trim first 30 seconds" / "remove the first minute" / "cut the intro"
  - "trim last 10s" / "drop the last 30 seconds" / "cut the outro"
  - "drop 0:30 to 0:45" / "remove the part between 1:00 and 1:30"
  - "keep just the first minute of these clips" / "cut everything after 0:30"
  - "split this clip" / "split the selected clip" / "split it in half"
  - "split at 0:45"
  - "reset video 2" / "clear the clips from video 1" / "start over with that one"

DO NOT use edit mode when:
  - There are no clips on the timeline yet — switch to plan / moment / extract instead.
  - The user wants a NEW clip from raw video ("first 1 minute" with no plan yet → extract, not edit).
  - The user is asking for an editorial change rather than a mechanical mutation ("make it punchier", "tighter cuts" → plan mode with planPatch).

Output:
  "mode": "edit"
  "operations": [ ... ]   // 1..N ops applied in order
  "message": "..."        // short, warm one-line confirmation

Each operation is one of:
  { "kind": "trim_first",  "seconds": <num>,  "sourceId"?: "src_..." }
  { "kind": "trim_last",   "seconds": <num>,  "sourceId"?: "src_..." }
  { "kind": "keep_range",  "startSeconds": <num>, "endSeconds": <num>, "sourceId"?: "src_..." }
  { "kind": "drop_range",  "startSeconds": <num>, "endSeconds": <num>, "sourceId"?: "src_..." }
  { "kind": "split_selected", "sourceId"?: "src_..." }
  { "kind": "split_at",       "timeSeconds": <num>, "sourceId"?: "src_..." }
  { "kind": "reset_source",   "sourceId"?: "src_..." }
  { "kind": "undo" }          // restore the timeline to before the last change

keep_range vs extract — READ CAREFULLY:
  - keep_range is RESTRICTIVE. It throws away everything on the source
    except the named window. Use it ONLY when the user says "keep just
    …", "keep only …", "cut everything except …", "trim it down to …".
    These mean "shrink what I have to this".
  - If the user is ADDING a window ("add 1:00 to 1:30", "also grab the
    part at 2:00", "include 0:30–0:45 too", "clip that bit as well"),
    that is NOT keep_range — it's EXTRACT mode with op = "append" (a NEW
    clip from raw video that joins the timeline). Never answer an
    additive request with keep_range; that would wipe the user's other
    clips. When the verb is "add" / "also" / "include" / "too" / "as
    well", choose extract-append, not edit.

undo — when the user says "undo", "undo that", "undo the last change",
  "bring those back", "put it back", "restore", "revert", emit:
    { "mode": "edit", "operations": [{ "kind": "undo" }],
      "message": "Brought the previous clips back." }
  This is always safe — if there's nothing to undo the client says so.

sourceId rules:
  - Omit when the user didn't name a specific video. Client uses the active source.
  - Include when the user said "video 2" / "the podcast one" / "the first clip" — match the name from the videoLibrary block to the right id.
  - For "trim first 30 from all videos" emit one op per selected source (each with its own sourceId).

Number parsing rules — the LLM (you) ALWAYS converts user phrasing to numeric seconds:
  - "1 minute"  →  60
  - "1m30s"     →  90
  - "0:45"      →  45
  - "minute and a half" →  90
  - "30s"       →  30
Do NOT pass strings or "1:30" through unparsed — the client expects numbers.

Examples:
  user: "trim the first minute"
       → { mode: "edit", operations: [{ kind: "trim_first", seconds: 60 }],
            message: "Trimmed the first minute." }
  user: "drop 0:30 to 0:45"
       → { operations: [{ kind: "drop_range", startSeconds: 30, endSeconds: 45 }],
            message: "Dropped 0:30–0:45." }
  user: "split this clip"
       → { operations: [{ kind: "split_selected" }],
            message: "Split the clip in half." }
  user: "reset the podcast video"  (videoLibrary has "podcast.mp4" = src_b)
       → { operations: [{ kind: "reset_source", sourceId: "src_b" }],
            message: "Cleared every clip from the podcast video." }
  user: "trim first 30s from all videos"  (3 videos selected: src_a, src_b, src_c)
       → { operations: [
              { kind: "trim_first", seconds: 30, sourceId: "src_a" },
              { kind: "trim_first", seconds: 30, sourceId: "src_b" },
              { kind: "trim_first", seconds: 30, sourceId: "src_c" }
            ],
            message: "Trimmed the first 30s from each video." }
`;

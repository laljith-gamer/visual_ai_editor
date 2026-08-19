export const FACTS_PROMPT = `
# factsToRemember (v1.7.0)

On every turn you MAY emit a small "factsToRemember" array with up to 4 candidate facts to persist for the rest of the session. The server merges these into the user's memory store; future turns will see them in the "What I remember" block. Use this aggressively — long sessions get sharper as memory accumulates.

Schema:
  {
    "subject":    "snake_case_short_id",   // ≤ 48 chars
    "value":      <primitive | string[]>,  // the actual fact
    "kind":       "intent" | "preference" | "context" | "constraint" | "feedback",
    "source":     "explicit" | "inferred" | "feedback",
    "confidence": 0..1,                    // ≥ 0.4 to be persisted
    "reason":     "<why you remembered this, ≤ 160 chars>"
  }

Worth remembering (examples):
  - { subject: "prefers_briefing_first", value: true, kind: "intent",
      source: "inferred", confidence: 0.85,
      reason: "user asked to describe without rendering twice" }
  - { subject: "preferred_duration", value: 30, kind: "preference",
      source: "explicit", confidence: 0.95,
      reason: "user said '30s' on first plan" }
  - { subject: "user_set_duration", value: true, kind: "preference",
      source: "explicit", confidence: 1.0,
      reason: "user explicitly named 30s" }
  - { subject: "user_set_duration", value: false, kind: "preference",
      source: "inferred", confidence: 0.85,
      reason: "user said 'best parts' with no length cue — keep timeline emergent" }
  - { subject: "video_genre", value: "lecture", kind: "context",
      source: "inferred", confidence: 0.7,
      reason: "long single-camera shot, talking-head, no music" }
  - { subject: "avoid_subjects", value: ["title cards", "logos"],
      kind: "constraint", source: "explicit", confidence: 1.0,
      reason: "user said skip the title cards" }
  - { subject: "format_lock", value: "vertical", kind: "preference",
      source: "explicit", confidence: 0.9,
      reason: "user repeatedly chose vertical" }

NOT worth remembering (skip these):
  - One-off acknowledgements ("ok", "yes", "go").
  - Trivia about a single clip (use clip metadata for that).
  - Anything with confidence < 0.4 — too noisy.

If a remembered fact contradicts the user's current message, the message wins. Emit a NEW fact with the corrected value and a reason that mentions the change ("user changed mind: now wants render, not briefing").
`;

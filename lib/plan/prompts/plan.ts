export const PLAN_PROMPT = `
## plan

The user wants a multi-clip highlight reel. They have either:
  - a topic + duration ("30s vertical of the funniest moments"),
  - just a vibe ("best parts", "highlights", "interesting bits"), or
  - a topic with a time bound ("first 2 min, pick best").

Emit a full plan or a planPatch (refinement). v1.5.0 fields:

  "signals": { "semantic": 0..1, "motion": 0..1, "saliency": 0..1 }
    Multi-signal fusion weights. The pipeline composes per-frame score as
       w_sem · semantic_match  +  w_mot · motion  +  w_sal · saliency
    Pick the profile that fits the prompt:
      - Concrete visual targets ("plating the dish", "guitar solo", "wedding kiss", "dunks", "the cat jumping"):
            { semantic: 0.7, motion: 0.2, saliency: 0.1 }
      - Topic given but abstract ("funny moments", "key takeaways", "highlights of the lecture"):
            { semantic: 0.5, motion: 0.3, saliency: 0.2 }
      - No clear visual target — "best parts", "interesting bits", "anything cool":
            { semantic: 0,   motion: 0.6, saliency: 0.4 }
    When semantic is 0 the SigLIP step is SKIPPED (huge speedup) and
    scenarios may be EMPTY in the plan. The pipeline will rank purely
    on motion + saliency in that case.

  "extractRange": { "kind": "first" | "last" | "absolute",
                    "startSeconds": <num>, "endSeconds": <num> }
    OPTIONAL. When present, the pipeline filters frames to this range
    BEFORE scoring + selection. Use this for prompts like "first 2 min,
    pick best" — emit a normal plan PLUS an extractRange covering the
    first 120 seconds.

  "constraints": { ... }    // CONSTRAINT-FIRST editing — READ CAREFULLY.
    OPTIONAL but REQUIRED whenever the user limits WHAT footage may appear.
    This is how you express "only X" / "ignore everything else" / "without Y".
    The pipeline treats this graph as the SINGLE SOURCE OF TRUTH: HARD
    constraints filter the footage BEFORE any scoring or ranking, and the
    pipeline NEVER falls back to generic highlights when a hard constraint is
    present. Shape:

      "constraints": {
        "goal": "create short video",
        "include": [
          { "id": "lab", "description": "<what is on screen>",
            "priority": "hard" | "soft", "scenarioIds": ["<scenario id>"] }
        ],
        "exclude": [
          { "id": "intro", "description": "<what to remove>",
            "scenarioIds": ["<scenario id>"] }
        ],
        "highlightMode": false,        // true ONLY if the user explicitly
                                       // asked for highlights / best moments
        "narrative": "chronological",
        "durationSeconds": <num>,       // when the user named a length
        "userSpecifiedDuration": true | false
      }

    RULES:
      - "only lab scenes" / "just the cooking parts" / "ignore everything
        else" → ONE include constraint with priority "hard" describing that
        scene. Its scenarioIds MUST reference a scenario you also put in the
        top-level "scenarios" array (so it gets visually scored).
      - "without the intro" / "avoid the menu screen" / "no talking head" →
        an exclude constraint. ALSO add a matching scenario (weight 0) to the
        top-level "scenarios" array so the excluded concept is visually
        recognised, NOT keyword-matched.
      - Use "soft" priority only when the user expressed a PREFERENCE, not a
        restriction ("mostly the kitchen, but a little b-roll is fine").
      - NEVER set highlightMode true for an "only X" request. "only X" is a
        constraint, not a highlight reel. highlightMode is for explicit
        "make a highlights reel / best parts" asks with no exclusivity.
      - When the user imposes NO restriction, OMIT constraints entirely and
        behave as before.

    WRITING THE SCENARIO FOR A CONSTRAINT (important for match quality):
      - For "only <subject> in <place/view>" (e.g. "only the user in lab view",
        "just the driving shots", "only talking-head moments") emit ONE rich,
        concrete scenario that describes the WHOLE scene as it appears on
        screen — subject + setting together — e.g.
        "a person standing or working inside a laboratory, lab benches and
        equipment visible in frame". Do NOT split it into several thin
        scenarios ("person", "standing", "lab") — fragmented prompts dilute the
        visual match and are the difference between a full reel and a single
        weak clip. One vivid scene description scores far better.
      - Lean semantic-heavy for such scene constraints:
        signals { semantic: 0.7, motion: 0.2, saliency: 0.1 }.
      - The include constraint's scenarioIds reference that single scenario.

    ASK BEFORE GUESSING (act like a real editor):
      - If the subject AND the scene are clear ("only the user in the lab"),
        DON'T over-ask — proceed with the plan + constraints.
      - But if the restriction is genuinely ambiguous — the scene/place is
        unnamed or could mean several things ("only the good parts", "just the
        important bits in there") — ask ONE focused clarify question first
        (what specifically should appear on screen), with concrete chips. A
        sharp question now beats a thin, wrong reel later. Never ask the same
        question twice.
`;

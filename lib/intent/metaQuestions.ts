// =====================================================================
// lib/intent/metaQuestions.ts
//
// Meta / explanation question guard (PURE, no imports).
//
// The app has many EDIT intents (create_short, highlight_reel,
// fix_existing_edit, export_render, …) but no first-class "explain what you
// did" route. So a question like "explain why you did these changes" used to
// fall through into edit-command parsing / the planner and could MUTATE the
// timeline. That is wrong.
//
// `parseMetaQuestion` recognises read-only explanation / history / reasoning
// / capability questions so the editor can answer them in chat and NEVER
// touch the timeline. It is deliberately conservative:
//
//   - It requires an explicit meta cue ("why" / "explain" / "what" / "how
//     come").
//   - It NEGATIVE-GUARDS any sentence that STARTS with a direct edit verb
//     (add/remove/delete/trim/replace/move/render/export/make/create/build/…)
//     — those are commands ("add explanation text", "make an explanation
//     video", "change this clip"), never meta — so we never steal an edit.
//
// Returns null when the turn is not a (confident) meta question, so the
// normal edit/planner paths run unchanged.
// =====================================================================

export type MetaQuestionKind =
  | "explain_previous_changes"
  | "what_changed"
  | "why_clip_selected"
  | "why_plan"
  | "what_will_happen"
  | "capability_explanation"
  | "unknown";

export interface MetaQuestion {
  kind: MetaQuestionKind;
  confidence: number;
  target?:
    | "last_action"
    | "timeline"
    | "clip"
    | "plan"
    | "render"
    | "history"
    | "capability";
}

/** A sentence that STARTS with one of these verbs is an instruction to DO
 *  something, not a question about the past — never meta. This is the key
 *  negative guard ("add why text", "make an explanation video", "change
 *  this clip", "replace this", "fix the timeline" → all edits). */
const EDIT_VERB_START =
  /^(?:please\s+|can you\s+|could you\s+|would you\s+|now\s+|hey,?\s+|ok,?\s+|okay,?\s+|just\s+|pls\s+|plz\s+)?(add|append|insert|put|remove|delete|drop|cut|trim|shorten|lengthen|extend|crop|replace|swap|move|reorder|rearrange|render|export|download|save|make|create|build|generate|produce|change|fix|adjust|tweak|mute|reverse|split|merge|combine|duplicate|speed|slow)\b/;

/** Must contain at least one of these to even be considered a question. */
const META_CUE = /\b(why|explain|what|what'?s|how come)\b/;

interface Rule {
  kind: MetaQuestionKind;
  target: NonNullable<MetaQuestion["target"]>;
  confidence: number;
  test: (lower: string) => boolean;
}

// Evaluated in order; first match wins. Specific kinds before the general
// "explain previous changes" catch-all.
const RULES: Rule[] = [
  // ---- capability: transition/render limitation ("why only fade") ----
  {
    kind: "capability_explanation",
    target: "capability",
    confidence: 0.9,
    test: (s) =>
      /\bwhy\b[\w\s'’]*\b(fade|crossfade|cross-fade|transitions?)\b/.test(s) ||
      /\bwhy (?:is it |does it |do you |are you )?(?:only|just|always)\b[\w\s'’]*\b(fade|cut|crossfade|transition)/.test(
        s
      )
  },
  // ---- capability: what the app can/can't do ----
  {
    kind: "capability_explanation",
    target: "capability",
    confidence: 0.88,
    test: (s) =>
      /\bwhat (?:can|could) (?:this app|the app|this|you|it|we|i)\b/.test(s) ||
      /\b(what'?s|what is|what are)\b[\w\s'’]*\b(un)?supported\b/.test(s) ||
      /\bwhat (?:is|are) (?:not )?supported\b/.test(s) ||
      /\bwhat (?:can'?t|cannot) (?:you|this|it|the app)\b/.test(s) ||
      /\bwhat (?:features|effects|transitions|capabilities)\b[\w\s'’]*\b(support|available|can|do)\b/.test(
        s
      ) ||
      /\bwhat (?:is|'?s) this app\b/.test(s)
  },
  // ---- what will happen if I render (FUTURE prediction) ----
  {
    kind: "what_will_happen",
    target: "render",
    confidence: 0.9,
    test: (s) =>
      /\bwhat (?:will|would|'?ll) happen\b/.test(s) ||
      /\bwhat happens (?:if|when|after|on|once)\b/.test(s) ||
      /\bwhat (?:will|would) (?:it|the (?:render|video|output|short|export)) (?:do|look|be|become|produce)\b/.test(
        s
      )
  },
  // ---- why this clip / why did you add this clip ----
  {
    kind: "why_clip_selected",
    target: "clip",
    confidence: 0.9,
    test: (s) =>
      /\bwhy\b[\w\s'’]*\b(this|that|the (?:selected|chosen|first|last|current))\s+(clip|part|moment|scene|segment|bit|shot|section)\b/.test(
        s
      ) ||
      /\bwhy (?:did|'?d) (?:you|u)\b[\w\s'’]*\b(add|pick|choose|chose|select|selected|include|use|used|keep|kept|remove|removed|cut|trim)\b[\w\s'’]*\b(this|that|it|these|those)\b/.test(
        s
      )
  },
  // ---- explain / why the plan, duration, format ----
  {
    kind: "why_plan",
    target: "plan",
    confidence: 0.88,
    test: (s) =>
      /\bexplain (?:the |this |your )?(?:edit )?plan\b/.test(s) ||
      /\bwhy (?:this|that|the)?\s*(plan|duration|length|target length)\b/.test(s) ||
      /\bwhy (?:is it|are we|did (?:you|u) (?:choose|pick|use|set|make it))\b[\w\s'’]*\b(\d+\s*(?:seconds?|secs?|s|minutes?|mins?)|vertical|horizontal|square|9:16|16:9)\b/.test(
        s
      ) ||
      /\bwhy (?:vertical|horizontal|square|9:16|16:9)\b/.test(s) ||
      /\bwhy (?:only |just )?\d+\s*(?:seconds?|secs?|minutes?|mins?)\b/.test(s)
  },
  // ---- what changed ----
  {
    kind: "what_changed",
    target: "timeline",
    confidence: 0.9,
    test: (s) =>
      /\bwhat (?:did|have) (?:you|u|we) chang/.test(s) ||
      /\bwhat'?s changed\b/.test(s) ||
      /\bwhat changed\b/.test(s) ||
      /\bwhat changes did (?:you|u|we)\b/.test(s)
  },
  // ---- explain the timeline / edit / your changes ----
  {
    kind: "explain_previous_changes",
    target: "timeline",
    confidence: 0.9,
    test: (s) =>
      /\bexplain (?:the |this |that |these |those |your |my )?(?:timeline|edit|edits|changes|reasoning|decisions?|choices?)\b/.test(
        s
      )
  },
  // ---- general "explain why you did this" / "what did you do" ----
  {
    kind: "explain_previous_changes",
    target: "last_action",
    confidence: 0.85,
    test: (s) =>
      /\bexplain why\b/.test(s) ||
      /\bwhy (?:did|'?d) (?:you|u)\b/.test(s) ||
      /\bwhy you did\b/.test(s) ||
      /\bwhy (?:these|those|the) changes\b/.test(s) ||
      /\bwhat (?:did|have) (?:you|u) (?:do|done)\b/.test(s) ||
      /\bwhat happened\b/.test(s) ||
      /\bhow come (?:you|u|it|we)\b/.test(s)
  }
];

/**
 * Detect a read-only meta/explanation question. Returns null when the turn
 * is not a confident meta question (so the normal edit/planner flow runs).
 */
export function parseMetaQuestion(text: string): MetaQuestion | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase().replace(/\s+/g, " ");

  // Fast bail: no meta cue at all.
  if (!META_CUE.test(lower)) return null;

  // Negative guard: edit-verb-led instructions are commands, never meta.
  if (EDIT_VERB_START.test(lower)) return null;

  for (const rule of RULES) {
    if (rule.test(lower)) {
      return { kind: rule.kind, confidence: rule.confidence, target: rule.target };
    }
  }
  return null;
}

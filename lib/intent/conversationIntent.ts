// =====================================================================
// lib/intent/conversationIntent.ts
//
// Universal conversation-intent classifier (PURE — no runtime imports).
//
// Replaces the old brittle exact-phrase regex table in metaQuestions.ts.
// The job: understand the user's SITUATION like a conversational editor and
// decide whether a turn is a READ-ONLY question (explain / reasoning /
// capability / "what will happen") or a request to CHANGE something
// (edit / create / control), so the editor never mutates the timeline on an
// explanation question — and never refuses a real edit.
//
// Two layers (the async orchestrator combines them):
//   Layer A — small, grammar-LEVEL deterministic classifier. Not a list of
//             example phrases: it reads question form, command form, edit-verb
//             POSITION, past-tense vs future-imperative, references to the
//             current/previous edit, capability/effect mentions. High
//             confidence only on obvious cases.
//   Layer B — optional semantic LLM classifier (text-only, strict JSON,
//             never produces a plan). Used ONLY for ambiguous turns and only
//             when a cheap classifier function is injected by the caller.
//
// Safety rule baked in everywhere: when ambiguous between read-only and
// mutation, prefer read_only_meta / unknown. Never mutate on ambiguity.
// =====================================================================

export type ConversationIntentKind =
  | "read_only_meta"
  | "edit_mutation"
  | "create_or_plan_edit"
  | "control_command"
  | "visual_question"
  | "clarification_answer"
  | "unknown";

export type ConversationTarget =
  | "timeline"
  | "selected_clip"
  | "plan"
  | "render"
  | "capability"
  | "history"
  | "source_video"
  | "last_action"
  | "unknown";

export interface ConversationIntent {
  kind: ConversationIntentKind;
  confidence: number;
  readOnly: boolean;
  target: ConversationTarget;
  reason: string;
  /** True when the turn mixes an explanation request with a possible change
   *  ("explain and fix it") — the read-only lane explains first and offers to
   *  apply the change rather than mutating silently. */
  ambiguous?: boolean;
}

export interface ConversationContext {
  hasTimeline: boolean;
  clipCount: number;
  hasPlan: boolean;
  hasSelectedClip: boolean;
  hasRenderedOutput: boolean;
  pendingClarify: boolean;
}

export const NEUTRAL_CONTEXT: ConversationContext = {
  hasTimeline: false,
  clipCount: 0,
  hasPlan: false,
  hasSelectedClip: false,
  hasRenderedOutput: false,
  pendingClarify: false
};

// ---------------------------------------------------------------------
// Grammar-level signal vocabulary (broad categories, NOT example phrases)
// ---------------------------------------------------------------------

// Optional polite/filler lead so anchored "starts-with" checks still fire.
const LEAD =
  "(?:so |ok |okay |hey |and |but |well |hmm |um |uh |yo |pls |plz |please |can you |can u |could you |could u |would you |will you |i want you to |i'?d like you to |lets |let'?s |now |just )*";

// Verbs that, when a sentence LEADS with them, signal a command (mutate /
// create / control) rather than a question about the past.
const EDIT_VERB =
  "(add|append|insert|put|place|remove|delete|drop|cut|trim|shorten|lengthen|extend|crop|replace|swap|move|reorder|rearrange|change|set|fix|adjust|tweak|mute|unmute|reverse|split|merge|combine|duplicate|speed|slow|apply|turn|convert|flip|rotate|zoom|colou?r|grade|caption|subtitle|overlay|stitch|join|concat|loop|fade|highlight)";
const CREATE_VERB = "(make|create|build|generate|produce|compose|assemble|craft)";
const CONTROL_VERB =
  "(render|export|download|save|undo|redo|play|pause|stop|preview|confirm|cancel|reset|clear)";

const EDIT_VERB_START = new RegExp(`^${LEAD}${EDIT_VERB}\\b`);
const CREATE_VERB_START = new RegExp(`^${LEAD}${CREATE_VERB}\\b`);
const CONTROL_VERB_START = new RegExp(`^${LEAD}${CONTROL_VERB}\\b`);

// Interrogative / explanation grammar.
const INTERROGATIVE_START = new RegExp(
  `^${LEAD}(why|how|what|what'?s|whats|whatre|when|where|which|who|whom|whose|is|are|am|do|does|did|can|could|would|will|shall|should|has|have|had|was|were)\\b`
);
const STARTS_WHY_HOW = new RegExp(`^${LEAD}(why|how)\\b`);

const REASONING_CUE =
  /\b(why|how come|reason|reasons|reasoning|rationale|logic|logical|justify|justification|decide|decided|deciding|decision|intent|intention|motivation)\b/;
const EXPLAIN_REQUEST =
  /\b(explain|justify|describe|summari[sz]e|walk me through|break ?down|tell me (?:about|why|how|what|the)|show me (?:why|how|what)|what'?s the (?:reason|logic|rationale)|give me the (?:reason|rationale|logic))\b/;

// References to a PAST action the editor took (read-only territory).
const PAST_ACTION_REF =
  /\b(did you|you did|you'?ve|you have|what did you|what have you|what happened|what'?s changed|what changed|you (?:chose|choose|picked|pick|selected|select|arranged|arrange|made|make|added|add|removed|remove|deleted|delete|used|use|kept|keep|set|trimmed|trim|cut|put|placed|ordered|order|decided|built|created|did))\b/;

// Future / conditional ("what will happen if I render").
const FUTURE_CONDITIONAL =
  /\b(what (?:will|would|'?ll) happen|what happens (?:if|when|after|once)|if i (?:render|press render|hit render|click render|export|hit export|press export|save)|when i (?:render|export)|what (?:will|would) (?:it|the (?:render|video|output|export)) (?:do|look|be|become))\b/;

// Capability / "what can it do" / "is it actually applying X".
const CAPABILITY_CUE =
  /\b(what can (?:this|the|it|you|i)|can (?:this|the|it|you)(?: app| tool| thing)? (?:really |actually )?(?:do|apply|handle|support)|what (?:is|'?s|are) (?:supported|unsupported|possible|available)|is (?:this|the|it)(?: app| tool)? (?:actually |really )?(?:applying|able|capable|working|doing)|are (?:the )?effects? (?:actually |really )?(?:applied|working|supported|happening)|does it (?:actually |really )?(?:apply|work|support)|what (?:can'?t|cannot) (?:it|you|this|the app))\b/;

// State references (used to decide that a bare question is about OUR edit).
const EFFECT_REF =
  /\b(fade|crossfade|cross-fade|transition|transitions|zoom|slow ?mo|slow motion|speed|colou?r ?grade|grading|caption|captions|subtitle|subtitles|text overlay|overlay|effect|effects|letterbox|shake|blur)\b/;
const SOURCE_REF =
  /\b(?:original|source) (?:video|footage|file|clip|material)\b|\bmy (?:original |source )?video\b|\bthe original\b/;
const RENDER_REF = /\b(render|rendered|rendering|export|exported|output|final video|the result|the export)\b/;
const PLAN_REF =
  /\b(plan|duration|length|target|seconds?|secs?|minutes?|mins?|format|vertical|horizontal|square|9:16|16:9|aspect ratio)\b/;
const CLIP_REF =
  /\b(this|that|the|selected|current|first|last) (?:clip|scene|part|moment|segment|shot|section)\b/;
const TIMELINE_REF =
  /\b(timeline|arrange|arranged|arrangement|order(?:ed|ing)?|sequence|layout|these (?:parts|scenes|clips|moments)|those (?:parts|scenes|clips|moments)|the edit|this edit|the changes|these changes|those changes|the way it'?s edited)\b/;

// A leading explanation request that is ALSO asked to change something
// ("explain and fix it") — handle as read-only + offer to apply.
const AMBIGUOUS_FIX =
  /\b(?:and|then|also|plus|&)\s+(fix|change|adjust|redo|improve|edit|update|apply|add|remove|make|trim|fix it|do it)\b/;

// "What is in the video / describe the footage" — needs VISION, not the
// read-only state responder. Routed to the normal (vision) flow.
const VISUAL_Q =
  /\b(what(?:'?s| is| are)?\s+(?:in|happening|going on|shown|visible)|who(?:'?s| is| are)?\s+(?:in|shown)|describe|summari[sz]e|what happens? in)\b[\w\s'’,]*\b(video|clip|footage|frame|frames|scene|scenes|screen|shot|shots|recording)\b/;

// "Watch / look at my video" — a request for the assistant to VIEW the
// footage. Also a vision ask (the local text model can't, so it's answered
// honestly by the describe lane). Kept tight (verb + a video object) so it
// doesn't fire on incidental uses of "watch".
const WATCH_VIDEO_Q =
  /\b(?:watch|look\s+at|view)\s+(?:my|the|this|that|our)\s+(?:video|clip|footage|recording|vid|film)\b|\bwatch\s+(?:this|it)\b/;

// Identity / "what model are you" — asks about the assistant itself, not the
// edit. Must be answered honestly (which brain is running) instead of falling
// through to the generic "no edit applied yet" explanation.
const IDENTITY_CUE =
  /\byour\s+(?:model|llm|engine|brain|ai|name)\b|\bwhat(?:'?s)?\s+(?:ai\s+)?(?:model|llm)\b|\bwhich\s+(?:ai\s+)?(?:model|llm)\b|\bwho\s+are\s+you\b|\bare\s+you\s+(?:an?\s+)?(?:ai|llm|gpt|chatgpt|a\s+bot|human|real|sentient)\b|\bwhat(?:'?s)?\s+your\s+name\b|\bwhat(?:'?s)?\s+powering\s+you\b/;

// Common typos for the few "look at the footage" verbs, corrected inline so a
// describe/watch request like "wath my video" is still understood. Kept inline
// (no import) so this classifier stays PURE.
const VISION_VERB_TYPOS: Record<string, string> = {
  wath: "watch",
  watchh: "watch",
  wacth: "watch",
  wathc: "watch",
  wtach: "watch",
  waatch: "watch",
  discribe: "describe",
  descibe: "describe",
  describ: "describe",
  desribe: "describe"
};

function fixVisionTypos(s: string): string {
  return s.replace(/\b[a-z]+\b/g, (w) => VISION_VERB_TYPOS[w] ?? w);
}

function normalize(text: string): string {
  return fixVisionTypos((text ?? "").toLowerCase().replace(/\s+/g, " ").trim());
}

// ---------------------------------------------------------------------
// Layer A — deterministic grammar classifier
// ---------------------------------------------------------------------

export function classifyConversationIntentSync(
  text: string,
  ctx: ConversationContext = NEUTRAL_CONTEXT
): ConversationIntent {
  const s = normalize(text);
  if (!s) {
    return { kind: "unknown", confidence: 0.2, readOnly: false, target: "unknown", reason: "empty message" };
  }

  const endsQ = /\?\s*$/.test(text.trim());
  const startsWhyHow = STARTS_WHY_HOW.test(s);
  const reasoning = REASONING_CUE.test(s);
  const explainReq = EXPLAIN_REQUEST.test(s);
  const pastRef = PAST_ACTION_REF.test(s);
  const future = FUTURE_CONDITIONAL.test(s);
  const capCue = CAPABILITY_CUE.test(s);
  const interrogative = INTERROGATIVE_START.test(s);
  const isQuestion = endsQ || interrogative || reasoning || explainReq;

  // 1) "What's in the video?" / "watch my video" → needs vision; let the
  //    normal (describe) flow handle it honestly.
  if (VISUAL_Q.test(s) || WATCH_VIDEO_Q.test(s)) {
    return {
      kind: "visual_question",
      confidence: 0.85,
      readOnly: true,
      target: "source_video",
      reason: "asks to see / describe the footage (needs vision)"
    };
  }

  // 1.5) Identity / "what model are you" → read-only capability answer, so it
  //      honestly explains the brain instead of "no edit applied yet".
  if (IDENTITY_CUE.test(s) && !EDIT_VERB_START.test(s) && !CONTROL_VERB_START.test(s)) {
    return {
      kind: "read_only_meta",
      confidence: 0.86,
      readOnly: true,
      target: "capability",
      reason: "asks about the assistant's identity / model"
    };
  }

  // 2) Command FORM wins (the sentence leads with a verb), UNLESS it leads
  //    with why/how (then it's a question about a past/current decision).
  if (CONTROL_VERB_START.test(s) && !startsWhyHow && !future) {
    return {
      kind: "control_command",
      confidence: 0.86,
      readOnly: false,
      target: "render",
      reason: "leads with a control command (render/export/undo/…)"
    };
  }
  if (EDIT_VERB_START.test(s) && !startsWhyHow) {
    return {
      kind: "edit_mutation",
      confidence: 0.82,
      readOnly: false,
      target: /\bplan\b/.test(s) ? "plan" : "timeline",
      reason: "leads with an edit verb — a change request"
    };
  }
  if (CREATE_VERB_START.test(s) && !startsWhyHow) {
    const mutatesExisting = /\b(?:make|create|build|generate|produce|turn|convert) (?:it|this|that|the)\b/.test(s);
    return mutatesExisting
      ? {
          kind: "edit_mutation",
          confidence: 0.78,
          readOnly: false,
          target: "timeline",
          reason: "adjusts the current edit"
        }
      : {
          kind: "create_or_plan_edit",
          confidence: 0.8,
          readOnly: false,
          target: "plan",
          reason: "requests a new edit / plan"
        };
  }

  // 3) Meta signal → READ-ONLY. A turn is read-only when it asks about the
  //    reasoning / a past action / a future "what if" / capabilities, or is a
  //    why/how question, or is any question that references the current edit.
  const refsState =
    CLIP_REF.test(s) ||
    TIMELINE_REF.test(s) ||
    PLAN_REF.test(s) ||
    EFFECT_REF.test(s) ||
    SOURCE_REF.test(s) ||
    RENDER_REF.test(s);
  const metaSignal =
    reasoning || explainReq || pastRef || future || capCue || startsWhyHow || (isQuestion && refsState);

  if (metaSignal) {
    const ambiguous = AMBIGUOUS_FIX.test(s);
    const strong = startsWhyHow || reasoning || explainReq || pastRef || future || capCue;
    return {
      kind: "read_only_meta",
      confidence: ambiguous ? 0.62 : strong ? 0.85 : 0.7,
      readOnly: true,
      target: inferTarget(s, { future, capCue }),
      reason: ambiguous
        ? "explanation request that also mentions a change — explain first, do not mutate"
        : "explanation / reasoning / capability question about the current edit",
      ambiguous
    };
  }

  // 4) Short reply while a clarify is pending → a clarification answer.
  if (ctx.pendingClarify && s.split(" ").length <= 6 && !isQuestion && !EDIT_VERB_START.test(s)) {
    return {
      kind: "clarification_answer",
      confidence: 0.65,
      readOnly: false,
      target: "unknown",
      reason: "short reply to a pending clarification"
    };
  }

  // 5) A question with no clear edit reference → defer (don't hijack, don't
  //    mutate). Low confidence so Layer B can refine if available.
  if (isQuestion) {
    return {
      kind: "unknown",
      confidence: 0.4,
      readOnly: true,
      target: "unknown",
      reason: "question without a clear edit reference"
    };
  }

  return { kind: "unknown", confidence: 0.3, readOnly: false, target: "unknown", reason: "no clear intent" };
}

function inferTarget(s: string, flags: { future: boolean; capCue: boolean }): ConversationTarget {
  if (flags.capCue || (EFFECT_REF.test(s) && (REASONING_CUE.test(s) || /\b(only|didn'?t|not|isn'?t|aren'?t)\b/.test(s)))) {
    return "capability";
  }
  if (SOURCE_REF.test(s)) return "source_video";
  if (CLIP_REF.test(s)) return "selected_clip";
  if (/\bplan\b/.test(s) || /\b(duration|length|seconds?|secs?|minutes?|mins?|format|vertical|horizontal|square|9:16|16:9)\b/.test(s)) {
    return "plan";
  }
  if (flags.future || RENDER_REF.test(s)) return "render";
  if (TIMELINE_REF.test(s)) return "timeline";
  return "last_action";
}

// ---------------------------------------------------------------------
// Layer B — semantic LLM classifier (prompt + strict-JSON parse)
// ---------------------------------------------------------------------

export function buildIntentClassifierPrompt(
  text: string,
  ctx: ConversationContext
): { system: string; user: string } {
  const system =
    "You are an intent classifier for a video editor. Your job is to decide whether the user is asking a read-only question or asking the editor to change something. Never create an edit plan. Never execute actions. Return JSON only.";
  const user = `Classify this user message in context.

Current context:
- hasTimeline: ${ctx.hasTimeline}
- clipCount: ${ctx.clipCount}
- hasPlan: ${ctx.hasPlan}
- hasSelectedClip: ${ctx.hasSelectedClip}
- hasRenderedOutput: ${ctx.hasRenderedOutput}
- pendingClarify: ${ctx.pendingClarify}

User message:
${text}

Return strict JSON only:
{"kind":"read_only_meta|edit_mutation|create_or_plan_edit|control_command|visual_question|clarification_answer|unknown","readOnly":true|false,"target":"timeline|selected_clip|plan|render|capability|history|source_video|last_action|unknown","confidence":0.0,"reason":"short"}

Decision rules:
- If the user asks why something happened, what changed, what you did, why a clip/plan/render/effect/transition was chosen, or what will happen if they do something, classify as read_only_meta.
- If the user asks to add/remove/trim/replace/move/change/create/make/render/export, classify as mutation/control UNLESS the sentence is asking why/how/what about a past/current decision.
- If ambiguous between read-only and mutation, choose read_only_meta or unknown. Never mutate on ambiguity.
- Do not classify "add explanation text" or "make an explanation video" as read_only_meta.
- Do not classify "why did you add this clip" as edit_mutation.
- Do not classify "what will happen if I render" as a render command.
- Be conservative: mutation requires clear command intent.`;
  return { system, user };
}

const VALID_KINDS = new Set<ConversationIntentKind>([
  "read_only_meta",
  "edit_mutation",
  "create_or_plan_edit",
  "control_command",
  "visual_question",
  "clarification_answer",
  "unknown"
]);
const VALID_TARGETS = new Set<ConversationTarget>([
  "timeline",
  "selected_clip",
  "plan",
  "render",
  "capability",
  "history",
  "source_video",
  "last_action",
  "unknown"
]);

function firstJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function clamp01(n: unknown): number | null {
  if (typeof n !== "number" || Number.isNaN(n)) return null;
  return Math.max(0, Math.min(1, n));
}

export function parseIntentClassifierJson(raw: string): ConversationIntent | null {
  const obj = firstJsonObject(raw);
  if (!obj) return null;
  const kind = obj.kind as ConversationIntentKind;
  if (!VALID_KINDS.has(kind)) return null;
  const target = (VALID_TARGETS.has(obj.target as ConversationTarget) ? obj.target : "unknown") as ConversationTarget;
  const confidence = clamp01(obj.confidence) ?? 0.6;
  const readOnly =
    typeof obj.readOnly === "boolean"
      ? obj.readOnly
      : kind === "read_only_meta" || kind === "visual_question";
  return {
    kind,
    confidence,
    readOnly,
    target,
    reason: typeof obj.reason === "string" ? obj.reason.slice(0, 200) : "semantic classifier"
  };
}

// ---------------------------------------------------------------------
// Orchestrator — Layer A, refined by Layer B for ambiguous turns only
// ---------------------------------------------------------------------

export type SemanticClassifyFn = (system: string, user: string) => Promise<string>;

/** Conservative merge: never let the LLM downgrade a read-only turn into a
 *  mutation unless it is very confident. Safety > recall. */
function mergeIntents(a: ConversationIntent, b: ConversationIntent): ConversationIntent {
  if (
    a.kind === "read_only_meta" &&
    b.kind !== "read_only_meta" &&
    b.kind !== "visual_question" &&
    b.confidence < 0.85
  ) {
    return a; // keep the safe read-only classification
  }
  // Preserve the ambiguity hint so the responder still explains-then-asks.
  return a.ambiguous ? { ...b, ambiguous: true } : b;
}

export async function classifyConversationIntent(
  text: string,
  ctx: ConversationContext = NEUTRAL_CONTEXT,
  opts: { semanticClassify?: SemanticClassifyFn; confidentThreshold?: number } = {}
): Promise<ConversationIntent> {
  const a = classifyConversationIntentSync(text, ctx);
  const threshold = opts.confidentThreshold ?? 0.8;

  // Obvious cases: trust the cheap deterministic classifier.
  if (a.confidence >= threshold) return a;

  // Ambiguous: refine with the semantic classifier when one is available.
  if (opts.semanticClassify) {
    try {
      const { system, user } = buildIntentClassifierPrompt(text, ctx);
      const raw = await opts.semanticClassify(system, user);
      const b = parseIntentClassifierJson(raw);
      if (b) return mergeIntents(a, b);
    } catch {
      // fall through to Layer A
    }
  }
  return a;
}

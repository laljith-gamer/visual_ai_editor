/**
 * v1.7.5 — Domain-specific synonym dictionaries for intent matching.
 *
 * Centralised here so contributors can extend per-locale or per-domain
 * vocabulary without hunting through the pattern files. Every list is
 * lowercased; the grammar layer handles morphology (plurals, verb
 * conjugations) via compromise's lemmatizer.
 *
 * If you add a new synonym, update the corresponding pattern's
 * confidence-tuning notes in patterns/<kind>.ts so we know what
 * trigger surface changed.
 */

// ---- Merge intent ----------------------------------------------------

/** Verbs (lemma form) that signal whole-source concatenation. */
export const MERGE_VERBS = [
  "merge",
  "join",
  "stitch",
  "concatenate",
  "concat",
  "combine",
  "glue",
  "unify",
  "link"
];

/** Object words that confirm "this is a merge of MEDIA" (vs e.g.
 *  merging styles or merging branches). Singular form; the matcher
 *  pluralises. */
export const MERGE_OBJECTS = [
  "video",
  "clip",
  "source",
  "file",
  "footage",
  // pronoun/quantifier targets that reference videos in context
  "them",
  "these",
  "those",
  "it",
  "all",
  "everything",
  "both"
];

/** Modifiers that strongly indicate "no editing — just concatenate". */
export const MERGE_AS_IS_MODIFIERS = [
  "as is",
  "as-is",
  "whole",
  "full",
  "entire",
  "no edit",
  "no editing",
  "no clip",
  "no clipping",
  "no scoring",
  "no effects"
];

// ---- Extract intent --------------------------------------------------

/** Verbs that hint at a verbatim-slice request. Optional — the time
 *  range slot is the strong signal; verbs just boost confidence. */
export const EXTRACT_VERBS = [
  "take",
  "grab",
  "pull",
  "slice",
  "give",
  "save",
  "extract",
  "get"
];

// ---- Edit intent (mechanical operations) -----------------------------

export const TRIM_VERBS = ["trim", "cut", "shave", "shorten", "remove", "delete"];
export const DROP_VERBS = ["drop", "remove", "delete", "skip", "exclude"];
export const KEEP_VERBS = ["keep", "retain", "preserve"];
export const SPLIT_VERBS = ["split", "divide", "break"];
export const RESET_VERBS = ["reset", "clear", "wipe"];

// ---- Promote intent (briefing → clips) -------------------------------

export const PROMOTE_VERBS = ["clip", "use", "take", "lift", "pull", "promote"];
export const PROMOTE_TARGETS = [
  "those",
  "them",
  "these",
  "the briefing",
  "the parts",
  "the moments",
  "the best parts",
  "the suggestions"
];

// ---- Affirm intent ---------------------------------------------------

/** Tokens that, when issued in response to a pending action, confirm
 *  it. Order matters only for log readability. */
export const AFFIRM_TOKENS = [
  "yes",
  "yeah",
  "yep",
  "yup",
  "go",
  "do it",
  "run",
  "run it",
  "sounds good",
  "ok",
  "okay",
  "alright",
  "proceed",
  "please do",
  "please proceed"
];

// ---- Cancel intent ---------------------------------------------------

export const CANCEL_TOKENS = [
  "cancel",
  "stop",
  "never mind",
  "nevermind",
  "forget it",
  "undo",
  "scrap that",
  "abort"
];

// ---- Time vocabulary -------------------------------------------------

export const TIME_UNITS_SECOND = ["second", "seconds", "sec", "secs", "s"];
export const TIME_UNITS_MINUTE = ["minute", "minutes", "min", "mins", "m"];
export const TIME_UNITS_HOUR = ["hour", "hours", "hr", "hrs", "h"];

/** English number words → numeric value. Used for "thirty seconds"
 *  / "ninety" / "two minutes" parsing. Compound numbers are handled
 *  by the parseNumber helper in time.ts. */
export const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
  thousand: 1000,
  // Common ordinal-as-cardinal misspeaks the user might say
  half: 0.5
};

/** English ordinal words used to resolve "the second video" / "first one". */
export const ORDINAL_TO_INDEX: Record<string, number> = {
  first: 0,
  "1st": 0,
  one: 0,
  second: 1,
  "2nd": 1,
  two: 1,
  third: 2,
  "3rd": 2,
  three: 2,
  fourth: 3,
  "4th": 3,
  four: 3,
  fifth: 4,
  "5th": 4,
  five: 4,
  sixth: 5,
  "6th": 5,
  seventh: 6,
  "7th": 6,
  eighth: 7,
  "8th": 7,
  ninth: 8,
  "9th": 8,
  tenth: 9,
  "10th": 9
};

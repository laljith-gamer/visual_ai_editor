/**
 * PR 59 — deterministic transition chat commands.
 *
 * Parses explicit transition instructions BEFORE the planner so they never
 * become a content search. Pure + dependency-light (type-only import) →
 * unit-testable. The runner (lib/agent/runAgentCommand.ts) applies the
 * result to the store and reports what changed + why.
 *
 * Supported:
 *   - "auto pick transitions" / "make transitions automatic" /
 *     "reset transitions to auto"      → auto_all
 *   - "make all transitions crossfade" / "all transitions fade"
 *                                       → set_all <type>
 *   - "set/add <type> between clip 1 and 2"
 *     "set transition between clip 1 and 2 to fade"
 *                                       → set_between
 *   - "make cuts faster" / "more cuts" / "punchier"   → set_all cut
 *   - "make it smoother" / "cinematic transitions"    → set_all crossfade
 *   - "remove transitions" / "no transitions"         → set_all cut
 */

import { ALL_TRANSITION_TYPES, type TransitionType } from "../transitions/types";

export type TransitionCommand =
  | { kind: "auto_all" }
  | { kind: "set_all"; type: TransitionType; styleReason?: string }
  | { kind: "set_between"; clipA: number; clipB: number; type: TransitionType };

/** Map spoken words to a TransitionType, or null. Order matters: multi-word
 *  forms ("dip to black", "match cut") are checked before bare words. */
export function parseTransitionType(text: string): TransitionType | null {
  const t = text.toLowerCase();
  if (/\bdip(\s+to\s+black)?\b/.test(t)) return "dip_to_black";
  if (/\bmatch[\s-]?cut\b/.test(t)) return "match_cut";
  if (/\bcross[\s-]?fade\b/.test(t)) return "crossfade";
  if (/\bwhip(\s+pan)?\b/.test(t)) return "whip";
  if (/\bglitch\b/.test(t)) return "glitch";
  if (/\bzoom\b/.test(t)) return "zoom";
  if (/\bslide\b/.test(t)) return "slide";
  if (/\bfade\b/.test(t)) return "fade";
  if (/\b(cut|hard\s+cut)\b/.test(t)) return "cut";
  return null;
}

const HAS_TRANSITION_WORD = /\btransitions?\b/;

export function parseTransitionCommand(text: string): TransitionCommand | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  const t = raw.toLowerCase();

  // 1. Between two specific clips ("... between clip 1 and 2 ...").
  const between = t.match(/between\s+clips?\s+(\d+)\s+(?:and|&|,)\s+(?:clip\s+)?(\d+)/);
  if (between) {
    const a = parseInt(between[1], 10);
    const b = parseInt(between[2], 10);
    const type = parseTransitionType(t) ?? "fade"; // "add a transition between 1 and 2" defaults to fade
    if (a > 0 && b > 0 && Math.abs(a - b) === 1) {
      return { kind: "set_between", clipA: Math.min(a, b), clipB: Math.max(a, b), type };
    }
    return null; // non-adjacent clips → not a single boundary; let it fall through
  }

  // 2. "remove / no / clear transitions" → all hard cuts.
  if (/\b(remove|clear|delete|no|without|drop)\b/.test(t) && HAS_TRANSITION_WORD.test(t)) {
    return { kind: "set_all", type: "cut", styleReason: "removed transitions (hard cuts)" };
  }

  // 3. "make ALL transitions <type>".
  if (/\ball\b/.test(t) && HAS_TRANSITION_WORD.test(t)) {
    const type = parseTransitionType(t);
    if (type) return { kind: "set_all", type };
  }

  // 4. "auto pick transitions" / "make transitions automatic" / "reset … auto".
  if (HAS_TRANSITION_WORD.test(t) && /\b(auto(?:[-\s]?pick)?|automatic|automatically)\b/.test(t)) {
    return { kind: "auto_all" };
  }
  if (/\bauto[-\s]?pick\b/.test(t) && /\btransition|cuts?\b/.test(t)) {
    return { kind: "auto_all" };
  }

  // 5. Faster / punchier cuts → all cuts.
  if (/\b(faster|quicker|more|punchy|punchier|snappy|snappier)\b.*\bcuts?\b/.test(t) ||
      /\bmake\s+(?:the\s+)?cuts?\s+(faster|quicker|punchier|snappier)\b/.test(t)) {
    return { kind: "set_all", type: "cut", styleReason: "faster, punchier cuts" };
  }

  // 6. Smoother / cinematic transitions → all crossfades.
  if ((/\b(smooth|smoother|cinematic|softer|gentle)\b/.test(t)) && (HAS_TRANSITION_WORD.test(t) || /\bcuts?\b/.test(t) || /\bmake it\b/.test(t))) {
    return { kind: "set_all", type: "crossfade", styleReason: "smoother, cinematic transitions" };
  }

  return null;
}

/** Exposed for callers that want to validate a parsed type is real. */
export function isKnownTransitionType(value: string): value is TransitionType {
  return (ALL_TRANSITION_TYPES as readonly string[]).includes(value);
}

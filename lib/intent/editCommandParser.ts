/**
 * Phase 1 — deterministic edit-command parser.
 *
 * Turns a natural user turn into a structured `EditCommand` using the
 * source/clip/time/placement parsers. This is the DETERMINISTIC FIRST
 * pass: it only returns a command when it is confident about the
 * structure; otherwise it returns `noCommand()` and the caller falls
 * through to the existing `quickMatch` gate and then the cloud planner
 * (so the LLM stays a fallback/enhancement, never the only resolver).
 *
 * It deliberately does NOT resolve concepts, durations against a video,
 * or apply anything — it only produces the structured command + a
 * confidence and any structural assumptions. Resolution + execution live
 * in the orchestrator and the timeline engine.
 */

import type { EditCommand, ParsedCommandResult } from "./command";
import { noCommand } from "./command";
import { parseSourceRef } from "./sourceResolver";
import { parseClipRef } from "./clipResolver";
import { parsePlacementSpec } from "./placementResolver";
import { parseTimeRangeSpec } from "./timeRangeParser";

const ADD_VERBS = ["add", "append", "include", "insert", "put", "pull", "grab", "take", "use", "pick", "find", "get", "show"];
const REMOVE_VERBS = ["remove", "delete", "drop", "discard", "cut out", "get rid of", "kill"];
const MOVE_VERBS = ["move", "shift", "reorder", "rearrange", "reposition"];
const EXTEND_VERBS = ["extend", "lengthen", "expand", "grow", "stretch"];
const TRIM_CLIP_VERBS = ["trim", "shorten", "tighten", "crop"];
const RENDER_VERBS = ["render", "export", "assemble", "produce", "finish", "build the video", "make the final"];

function startsWithAny(lower: string, verbs: string[]): string | null {
  for (const v of verbs) {
    const re = new RegExp(`^(?:please\\s+|can you\\s+|could you\\s+|now\\s+)?${escapeRe(v)}\\b`);
    if (re.test(lower)) return v;
  }
  return null;
}

function containsAny(lower: string, verbs: string[]): boolean {
  return verbs.some((v) => new RegExp(`\\b${escapeRe(v)}\\b`).test(lower));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strip a substring (case-insensitive) once from a text. */
function stripOnce(text: string, fragment: string): string {
  if (!fragment) return text;
  const i = text.toLowerCase().indexOf(fragment.toLowerCase());
  if (i < 0) return text;
  return (text.slice(0, i) + text.slice(i + fragment.length)).replace(/\s{2,}/g, " ").trim();
}

export function parseEditCommand(text: string): ParsedCommandResult {
  const raw = (text ?? "").trim();
  if (!raw) return noCommand();
  const lower = raw.toLowerCase();

  // ---- render ------------------------------------------------------
  if (startsWithAny(lower, RENDER_VERBS) || /^(?:render|export)(?:\s+it)?$/.test(lower)) {
    return ok({ op: "render" }, 0.9);
  }

  // ---- replace clip N with <range|concept> -------------------------
  {
    const m = lower.match(/\breplace\s+(.+?)\s+with\s+(.+)$/);
    if (m) {
      const target = parseClipRef(m[1]);
      if (target) {
        const replSourceRef = parseSourceRef(m[2]) ?? undefined;
        const replRange = parseTimeRangeSpec(m[2]);
        if (replRange) {
          return ok({ op: "replace_clip", target, replacement: { kind: "range", sourceRef: replSourceRef, range: replRange } }, 0.86);
        }
        const concept = cleanConcept(m[2], replSourceRef?.spoken);
        if (concept) {
          return ok({ op: "replace_clip", target, replacement: { kind: "concept", sourceRef: replSourceRef, concept } }, 0.82);
        }
      }
    }
  }

  // ---- move / reorder clip <placement> -----------------------------
  if (startsWithAny(lower, MOVE_VERBS)) {
    const clipRef = parseClipRef(stripLeadingVerb(lower, MOVE_VERBS));
    const placement = parsePlacementSpec(lower);
    if (clipRef && placement) {
      return ok({ op: "move_clip", clipRef, placement }, 0.85);
    }
    if (clipRef && !placement) {
      return clarify("Where should I move it — before or after which clip?");
    }
  }

  // ---- extend clip by N seconds / add N sec before|after clip ------
  {
    // "extend clip 2 by 3 seconds" / "extend clip 1 3 seconds at the end"
    if (startsWithAny(lower, EXTEND_VERBS)) {
      const clipRef = parseClipRef(lower);
      const before = lower.match(/(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\s+(?:before|at the (?:start|front)|to the front)/);
      const after = lower.match(/(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\s+(?:after|at the end|to the end)/);
      const byAmount = lower.match(/by\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)/);
      if (clipRef) {
        const beforeSeconds = before ? parseFloat(before[1]) : undefined;
        let afterSeconds = after ? parseFloat(after[1]) : undefined;
        if (!before && !after && byAmount) afterSeconds = parseFloat(byAmount[1]);
        if (beforeSeconds != null || afterSeconds != null) {
          return ok({ op: "extend_clip", clipRef, beforeSeconds, afterSeconds }, 0.83);
        }
      }
    }
    // "add 2 seconds before clip 1" → extend.
    const addExtend = lower.match(
      /\badd\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\s+(before|after)\s+(.+)$/
    );
    if (addExtend) {
      const clipRef = parseClipRef(addExtend[3]);
      const secs = parseFloat(addExtend[1]);
      if (clipRef && !Number.isNaN(secs)) {
        return ok(
          addExtend[2] === "before"
            ? { op: "extend_clip", clipRef, beforeSeconds: secs }
            : { op: "extend_clip", clipRef, afterSeconds: secs },
          0.8
        );
      }
    }
  }

  // ---- trim clip <range> -------------------------------------------
  if (startsWithAny(lower, TRIM_CLIP_VERBS)) {
    const clipRef = parseClipRef(lower);
    const range = parseTimeRangeSpec(lower);
    if (clipRef && range && range.kind === "absolute") {
      return ok({ op: "trim_clip", clipRef, start: range.startSeconds, end: range.endSeconds }, 0.8);
    }
    // No explicit clip → let the existing edit shortcut / planner handle
    // "trim first 30s" style timeline-wide trims.
  }

  // ---- remove / delete clip ----------------------------------------
  if (startsWithAny(lower, REMOVE_VERBS) || /^(?:not\s+this|remove\s+this)$/.test(lower)) {
    // Only treat as remove_clip when a CLIP is referenced (not a raw
    // time range — that's a drop_range edit handled elsewhere).
    if (!parseTimeRangeSpec(lower)) {
      const clipRef = parseClipRef(lower) ?? (/(this|that|it)\b/.test(lower) ? parseClipRef("this") : null);
      if (clipRef) return ok({ op: "remove_clip", clipRef }, 0.84);
    }
  }

  // ---- add (range | clip ref | concept) ----------------------------
  const addVerb = startsWithAny(lower, ADD_VERBS);
  if (addVerb) {
    const sourceRef = parseSourceRef(lower) ?? undefined;
    const placement = parsePlacementSpec(lower) ?? undefined;

    // (a) explicit time range → add_range (exact ranges respected).
    const range = parseTimeRangeSpec(lower);
    if (range) {
      return ok({ op: "add_range", sourceRef, range, placement }, 0.85);
    }

    // (b) "add clip N" referencing an EXISTING timeline clip, placed
    //     somewhere → add_clip_ref. Require a placement OR a bare
    //     "clip N" with no concept words so we don't grab "add the
    //     clip where he scores".
    const clipRef = parseClipRef(lower);
    if (clipRef && (clipRef.kind === "index" || clipRef.kind === "first" || clipRef.kind === "last") && placement) {
      return ok({ op: "add_clip_ref", clipRef, placement }, 0.82);
    }

    // (c) concept search → add_concept.
    let conceptText = stripLeadingVerb(lower, ADD_VERBS);
    if (placement) conceptText = stripOnce(conceptText, placement.spoken);
    if (sourceRef) conceptText = stripOnce(conceptText, sourceRef.spoken);
    const concept = cleanConcept(conceptText, sourceRef?.spoken);
    if (concept) {
      return ok({ op: "add_concept", sourceRef, concept, placement }, conceptConfidence(concept));
    }
  }

  return noCommand();
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function stripLeadingVerb(lower: string, verbs: string[]): string {
  let out = lower;
  for (const v of verbs) {
    const re = new RegExp(`^(?:please\\s+|can you\\s+|could you\\s+|now\\s+)?${escapeRe(v)}\\b`);
    if (re.test(out)) {
      out = out.replace(re, "").trim();
      break;
    }
  }
  return out;
}

const CONCEPT_STOP = new Set(["the", "a", "an", "me", "some", "of", "from", "in", "please", "part", "parts", "bit", "section", "moment", "moments"]);

/** Clean a concept phrase: drop a trailing source mention, collapse
 *  whitespace, and bail if nothing meaningful remains. */
function cleanConcept(text: string, sourceSpoken?: string): string {
  let out = text;
  if (sourceSpoken) out = stripOnce(out, sourceSpoken);
  out = out
    .replace(/\bfrom\s+(?:video|source|the)\b.*$/i, "")
    .replace(/[?.!,]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!out) return "";
  // Require at least one non-stopword token of length >= 2 so an empty
  // "add the part" doesn't become a concept search for nothing.
  const tokens = out.split(/\s+/).filter((t) => t.length >= 2 && !CONCEPT_STOP.has(t));
  if (tokens.length === 0) return "";
  return out;
}

/** "best parts" style generic asks are lower-confidence concept searches
 *  (they fall back to visual/motion); a specific concept is higher. */
function conceptConfidence(concept: string): number {
  const generic = /^(?:best|good|cool|nice|interesting|highlight)(?:\s+(?:parts?|bits?|moments?|clips?))?$/.test(concept.trim());
  return generic ? 0.7 : 0.78;
}

function ok(command: EditCommand, confidence: number): ParsedCommandResult {
  return { command, confidence, assumptions: [], needsClarification: false };
}

function clarify(message: string): ParsedCommandResult {
  return { command: null, confidence: 0.4, assumptions: [], needsClarification: true, clarification: message };
}

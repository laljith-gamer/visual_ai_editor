// =====================================================================
// lib/timeline/overlapIntent.ts
//
// PURE parser: map a user's reply to an overlap-conflict question (or an
// up-front instruction like "add it but keep both") to a concrete overlap
// resolution. Used by the editor when a pending overlap conflict exists, and
// to honor an explicit instruction at add-time so we don't ask needlessly.
//
// PURE: imports the resolution type only. Unit-tested.
// =====================================================================

import type { OverlapResolution } from "./overlapResolver";

export type ExplicitOverlapResolution = Exclude<OverlapResolution, "ask_user">;

const KEEP_BOTH = /\b(keep\s+both|both|add\s+(?:it\s+)?too|keep\s+(?:the\s+)?(?:new\s+)?(?:one\s+)?and|leave\s+both)\b/i;
const REPLACE = /\b(replace|swap|overwrite|use\s+(?:the\s+)?new(?:\s+one)?(?:\s+instead)?|drop\s+the\s+old|delete\s+the\s+old)\b/i;
const TRIM = /\b(trim|cut\s+(?:the\s+)?overlap|shorten|non[- ]?overlap|trim\s+(?:to\s+)?fit)\b/i;
const SKIP = /\b(skip(?:\s+(?:the\s+)?new)?|don'?t\s+add|cancel\s+(?:the\s+)?(?:new\s+)?(?:add|clip)|keep\s+(?:the\s+)?old(?:\s+one)?(?:\s+only)?|leave\s+it)\b/i;

/**
 * Parse an explicit overlap resolution from free text. Returns null when no
 * clear choice is present (the caller then asks). Order matters: "keep both"
 * is checked before the generic "keep old" skip.
 */
export function parseOverlapResolution(text: string): ExplicitOverlapResolution | null {
  const s = (text ?? "").trim();
  if (!s) return null;
  if (KEEP_BOTH.test(s)) return "keep_both";
  if (REPLACE.test(s)) return "replace_existing";
  if (TRIM.test(s)) return "trim_new";
  if (SKIP.test(s)) return "skip_new";
  return null;
}

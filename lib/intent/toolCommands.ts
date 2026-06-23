// =====================================================================
// lib/intent/toolCommands.ts
//
// Deterministic chat commands for editor TOOLS that previously had no
// natural-language path: output FORMAT/aspect, and LIBRARY/source control
// (which videos the AI uses, and which is active in the preview).
//
// Parsed BEFORE the planner (like transitionCommands.ts) so they never
// become a content search. PURE + dependency-light (reuses parseSourceRef
// for "video 2" / "the second video" / "all videos"). The runner
// (lib/agent/runAgentCommand.ts) applies the result to the store.
// =====================================================================

import { parseSourceRef } from "./sourceResolver";
import type { SourceRef } from "./command";

export type ToolFormat = "vertical" | "horizontal" | "square";

export type ToolCommand =
  | { kind: "set_format"; format: ToolFormat }
  | { kind: "select_all_sources" }
  | { kind: "select_active_only" }
  | { kind: "select_only"; ref: SourceRef }
  | { kind: "select_include"; ref: SourceRef }
  | { kind: "switch_active"; ref: SourceRef };

// ---------------------------------------------------------------------
// FORMAT / aspect
// ---------------------------------------------------------------------

const FORMAT_TOKEN =
  "(vertical|portrait|9\\s*[:x]\\s*16|horizontal|landscape|widescreen|16\\s*[:x]\\s*9|square|1\\s*[:x]\\s*1)";

// Whole-message format directive: optional lead + optional verb/object +
// the format token + optional trailing filler. Anchored so a CREATE request
// that merely mentions a format ("make a vertical reel of the fight") does
// NOT match (the extra content fails the end anchor).
const FORMAT_RE = new RegExp(
  "^(?:(?:so|ok|okay|now|and|please|hey)[,\\s]+)*" +
    "(?:(?:can|could)\\s+you\\s+)?" +
    "(?:(?:make|change|set|switch|convert|turn|flip|render|export|keep)\\s+)?" +
    "(?:(?:it|this|the)\\s+(?:video|short|reel|output|format|aspect(?:\\s*ratio)?|orientation)?\\s*)?" +
    "(?:(?:to|into|as|in)\\s+)?" +
    FORMAT_TOKEN +
    "(?:\\s+(?:format|aspect(?:\\s*ratio)?|mode|version|orientation|please|now))?[.!]*$",
  "i"
);

function mapFormat(token: string): ToolFormat {
  const t = token.toLowerCase().replace(/\s+/g, "");
  if (/^(vertical|portrait|9[:x]16)$/.test(t)) return "vertical";
  if (/^(horizontal|landscape|widescreen|16[:x]9)$/.test(t)) return "horizontal";
  return "square"; // square | 1:1
}

/** Parse a standalone format/aspect change request, or null. */
export function parseFormatCommand(text: string): { format: ToolFormat } | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  const m = raw.match(FORMAT_RE);
  if (!m) return null;
  return { format: mapFormat(m[1]) };
}

// ---------------------------------------------------------------------
// LIBRARY / source control
// ---------------------------------------------------------------------

const AI_SCOPE = /\b(for ai|for the (?:ai|edit|reel|short|next run)|in the (?:ai|edit|reel))\b/;

/**
 * Parse a library/source-control command, or null. Covers:
 *   - "use all videos" / "include every video"      → select_all_sources
 *   - "active only" / "just this video for ai"       → select_active_only
 *   - "use only video 2" / "only the second video"   → select_only <ref>
 *   - "also use video 1" / "include video 3"         → select_include <ref>
 *   - "switch to video 2" / "show video 1" / "open the second video"
 *                                                    → switch_active <ref>
 */
export function parseSourceControlCommand(text: string): ToolCommand | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  const t = raw.toLowerCase();

  // Must clearly be about videos/sources to avoid catching content turns.
  const mentionsSource = /\b(video|videos|source|sources|upload|uploads|clip(?!\s*\d)|footage)\b/.test(t);

  // Switch the ACTIVE/preview source: "switch to video 2", "show video 1",
  // "open/preview the second video", "make video 2 active".
  if (
    /\b(switch to|show|open|preview|go to|jump to|view)\b/.test(t) ||
    /\bmake\s+(?:video|source)\s+\d+\s+active\b/.test(t) ||
    /\bactivate\b/.test(t)
  ) {
    const ref = parseSourceRef(t);
    if (ref && (ref.kind === "index" || ref.kind === "name_hint")) {
      return { kind: "switch_active", ref };
    }
  }

  // Selection for the AI run.
  const wantsOnly = /\b(only|just|nothing but)\b/.test(t);
  const wantsInclude = /\b(also|include|add|plus|too)\b/.test(t);
  const wantsUseOrSelect = /\b(use|select|pick|choose|set)\b/.test(t);

  // "active only" / "only this video" / "current video only".
  if (
    wantsOnly &&
    /\b(active|current|this)\b/.test(t) &&
    /\b(video|source|one)\b/.test(t)
  ) {
    return { kind: "select_active_only" };
  }

  // "use all videos" / "every video" / "all sources".
  if ((wantsUseOrSelect || wantsInclude) && /\b(all|every|both)\b/.test(t) && mentionsSource) {
    return { kind: "select_all_sources" };
  }
  // Bare "all videos" / "use everything".
  if (/\b(all|every|both)\s+(?:the\s+)?(videos?|sources?|uploads?)\b/.test(t)) {
    return { kind: "select_all_sources" };
  }

  // "use only video 2" / "only the second video".
  if (wantsOnly && mentionsSource) {
    const ref = parseSourceRef(t);
    if (ref && (ref.kind === "index" || ref.kind === "name_hint")) {
      return { kind: "select_only", ref };
    }
  }

  // "also use video 1" / "include video 3 in the edit".
  if (wantsInclude && mentionsSource) {
    const ref = parseSourceRef(t);
    if (ref && (ref.kind === "index" || ref.kind === "name_hint")) {
      return { kind: "select_include", ref };
    }
  }

  // Bare AI-scope selection: "video 2 for ai", "use video 1 for the reel".
  if (AI_SCOPE.test(t) && mentionsSource) {
    const ref = parseSourceRef(t);
    if (ref && (ref.kind === "index" || ref.kind === "name_hint")) {
      return { kind: "select_only", ref };
    }
  }

  return null;
}

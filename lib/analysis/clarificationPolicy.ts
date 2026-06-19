// =====================================================================
// lib/analysis/clarificationPolicy.ts
//
// Decide whether to ASK the user one focused question BEFORE spending
// expensive deeper analysis. A good editor doesn't silently guess on a
// vague brief or burn a deep scan when the quick scan is inconclusive — it
// asks. Returns at most ONE question (the highest-priority gap) with option
// chips, so the editor can reuse the existing pendingClarify / QuickReplies.
//
// PURE: only imports the centralized thresholds. Unit-tested.
// =====================================================================

import { CLARIFY_POLICY } from "../config";
import type { AnalysisPurpose, PromptSpecificity } from "./types";

export type ClarificationKind =
  | "content_priority"
  | "broaden"
  | "source_roles"
  | "style"
  | "deeper_scan";

export interface ClarificationInput {
  purpose: AnalysisPurpose;
  promptSpecificity: PromptSpecificity;
  sourceCount: number;
  /** Quick-scan confidence (0..1), if a quick scan has run. */
  quickScanConfidence?: number;
  /** Distinct strong content types detected (e.g. ["talking","action"]). */
  detectedContentTypes?: string[];
  /** Strength (0..1) of the best candidate window, if known. */
  candidateWindowStrength?: number;
  /** Whether the user gave an explicit target duration. */
  userSpecifiedDuration?: boolean;
  targetSeconds?: number;
  /** Best coverage achievable of the target so far (seconds). */
  achievableSeconds?: number;
  /** Multi-video: source roles couldn't be confidently inferred. */
  unclearSourceRoles?: boolean;
}

export interface ClarificationDecision {
  shouldAsk: boolean;
  kind?: ClarificationKind;
  message?: string;
  suggestions?: string[];
  reason: string;
}

const NO_ASK: ClarificationDecision = { shouldAsk: false, reason: "enough information to proceed" };

/**
 * Returns the single highest-priority clarification to ask, or shouldAsk:false.
 * Order: concrete conflicts first (content mix, underfill), then ambiguous
 * direction (roles, style), then a low-confidence "scan deeper?" prompt.
 */
export function decideClarification(input: ClarificationInput): ClarificationDecision {
  // 1) Quick scan found multiple distinct content types → which to prioritize?
  const types = (input.detectedContentTypes ?? []).filter(Boolean);
  if (types.length >= CLARIFY_POLICY.multiContentTypeFloor) {
    const list = types.slice(0, 4);
    return {
      shouldAsk: true,
      kind: "content_priority",
      message: `I found ${list.join(", ")} sections. Which should I prioritize?`,
      suggestions: [...list.map(capitalize), "A mix of everything"],
      reason: "quick scan detected multiple content types"
    };
  }

  // 2) Explicit target that can't be filled → broaden or accept shorter?
  if (
    input.userSpecifiedDuration &&
    typeof input.targetSeconds === "number" &&
    input.targetSeconds > 0 &&
    typeof input.achievableSeconds === "number"
  ) {
    const fraction = input.achievableSeconds / input.targetSeconds;
    if (fraction < CLARIFY_POLICY.underfillAskFraction) {
      return {
        shouldAsk: true,
        kind: "broaden",
        message: `I can confidently fill about ${Math.round(input.achievableSeconds)}s of your ${Math.round(
          input.targetSeconds
        )}s target. Should I broaden the search or keep it tight?`,
        suggestions: ["Broaden the search", `Keep the strong ${Math.round(input.achievableSeconds)}s`, "Run a deeper local scan"],
        reason: "explicit target can't be confidently filled"
      };
    }
  }

  // 3) Multi-video story with unclear source roles → ask the structure.
  if (input.sourceCount > 1 && (input.unclearSourceRoles || input.purpose === "deep_story")) {
    if (input.unclearSourceRoles || input.promptSpecificity === "vague") {
      return {
        shouldAsk: true,
        kind: "style",
        message: "Do you want a story-style edit or a fast montage?",
        suggestions: ["Story style", "Fast montage", "You decide"],
        reason: "multi-video edit style is unclear"
      };
    }
  }

  // 4) Vague single-video creative request → ask the vibe before scanning.
  if (input.promptSpecificity === "vague") {
    return {
      shouldAsk: true,
      kind: "style",
      message: "What kind of short do you want?",
      suggestions: ["Best moments reel", "Fast montage", "One continuous clip", "Describe the video first"],
      reason: "vague creative request with no direction"
    };
  }

  // 5) Quick scan ran but is low-confidence / no clear subject → scan deeper?
  const conf = input.quickScanConfidence;
  const weakWindows =
    typeof input.candidateWindowStrength === "number" &&
    input.candidateWindowStrength < CLARIFY_POLICY.weakWindowCeiling;
  if ((typeof conf === "number" && conf < CLARIFY_POLICY.lowConfidence) || weakWindows) {
    return {
      shouldAsk: true,
      kind: "deeper_scan",
      message:
        "My quick scan didn't find a clear subject. Want me to run a deeper local scan, or make a motion-based highlight reel?",
      suggestions: ["Run a deeper local scan", "Motion-based highlight reel", "Describe what you're looking for"],
      reason: "low-confidence quick scan / weak candidate windows"
    };
  }

  return NO_ASK;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

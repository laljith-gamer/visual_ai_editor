// =====================================================================
// lib/agent/describeResponder.ts
//
// Honest, INSTANT, LOCAL response to "describe what's in this video" — the
// reported-bug fix. A describe request must NOT build a short or run the
// full highlight pipeline. It answers from what we already know (metadata +
// any cached analysis memory + whether a transcript exists) and offers clear
// next steps. It is honest about local limits: without on-device captioning
// we don't claim to name on-screen subjects from thin air.
//
// PURE: imports only the videoMemory summarizer (pure) + types. The editor
// builds the state from the store and pushes the result; nothing is mutated.
// =====================================================================

import type { DeviceTier, VideoAnalysisMemory } from "../analysis/types";
import { summarizeVideoMemory, motionProfile } from "../analysis/videoMemory";

export interface DescribeState {
  hasVideo: boolean;
  sourceName?: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  /** A local transcript exists for this source. */
  hasTranscript?: boolean;
  /** Cached analysis memory for the active source, if any. */
  memory?: VideoAnalysisMemory | null;
  deviceTier?: DeviceTier;
}

export interface DescribeResponse {
  message: string;
  suggestions: string[];
  /** True when we still need a scan / clarification to say more. */
  needsMore: boolean;
}

function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const SCAN_CHIP = "Run a quick local scan";
const REEL_CHIP = "Make a motion-based highlight reel";
const FIND_CHIP = "Find something specific";

/**
 * Build an honest local description + next-step chips. Never mutates state,
 * never runs the pipeline. The editor surfaces this and stops.
 */
export function buildDescribeResponse(state: DescribeState): DescribeResponse {
  if (!state.hasVideo) {
    return {
      message: "Upload a video into the rail first, then I can describe what's in it.",
      suggestions: [],
      needsMore: true
    };
  }

  const facts: string[] = [];
  if (typeof state.durationSeconds === "number" && state.durationSeconds > 0) {
    facts.push(fmtTime(state.durationSeconds));
  }
  if (state.width && state.height) facts.push(`${state.width}×${state.height}`);
  const factLine = facts.length > 0 ? ` (${facts.join(", ")})` : "";
  const name = state.sourceName ? `"${state.sourceName}"` : "this video";

  // ---- We already have an analysis memory → describe from it (honest) ----
  const mem = state.memory;
  if (mem && mem.level >= 1) {
    const lines: string[] = [`Here's what I know about ${name}${factLine}, from my earlier scan:`, summarizeVideoMemory(mem)];
    const profile = motionProfile(mem);
    const hasCaptions = mem.keyframes.some((k) => (k.caption ?? "").trim().length > 0);
    if (!hasCaptions) {
      lines.push(
        "That's a structural read (scenes, motion, strong windows) — I haven't run on-device captioning, so I can't reliably name the subjects on screen yet."
      );
    }
    const suggestions = [REEL_CHIP, FIND_CHIP];
    if (mem.level < 3) suggestions.unshift("Run a deeper local scan");
    if (state.hasTranscript) suggestions.push("Search what's said");
    return { message: lines.join("\n"), suggestions, needsMore: profile === "unknown" || mem.confidence < 0.4 };
  }

  // ---- No analysis yet → be honest; offer a quick local scan ----
  const lines: string[] = [
    `I can see the file details for ${name}${factLine}, but I haven't scanned the frames yet, so I can't reliably say what's on screen from local analysis alone.`
  ];
  if (state.hasTranscript) {
    lines.push("I do have a transcript for it, so I can also search what's said.");
  }
  lines.push(
    "Want me to run a quick local scan (a few keyframes — motion + scene structure, on-device, no cloud), or make a motion-based highlight reel?"
  );

  const suggestions = [SCAN_CHIP, REEL_CHIP, FIND_CHIP];
  if (state.hasTranscript) suggestions.push("Search what's said");

  return { message: lines.join("\n"), suggestions, needsMore: true };
}

// =====================================================================
// lib/llm/prompt.ts
//
// Prompt for the LOCAL (small, in-browser) planner. Deliberately tighter
// and more example-driven than the cloud planner prompt: small models
// follow concrete schemas + few-shot examples far better than prose
// rules. We restrict to three reliable modes (plan / extract / clarify)
// and ALWAYS demand a single JSON object (JSON-mode enforces wellformed-
// ness; the prompt enforces the SHAPE).
// =====================================================================

import type { LocalChatMessage, LocalPlannerContext } from "@/lib/llm/types";

export const LOCAL_PLANNER_SYSTEM_PROMPT = `You convert a user's video-editing request into ONE JSON object. Output JSON ONLY — no prose, no markdown, no code fences. First char "{", last char "}".

Pick exactly one "mode":

1) "plan" — the user wants a highlight reel / clips of some SUBJECT.
   {
     "mode": "plan",
     "scenarios": [{ "id": "short_id", "prompt": "concrete on-screen description" }],
     "signals": { "semantic": 0.7, "motion": 0.2, "saliency": 0.1 },
     "selectionStrategy": "balanced",
     "message": "one short sentence"
   }
   - scenarios: 1-4 CONCRETE visual descriptions of what would be ON SCREEN.
     Translate the user's words, even if terse ("food prep" -> "close-up of
     hands chopping or measuring ingredients on a counter").
   - If the user said "best parts" / "highlights" / "anything good" with NO
     subject: scenarios = [] and signals = { "semantic": 0, "motion": 0.6, "saliency": 0.4 }.
   - Otherwise use semantic-heavy signals (semantic >= 0.5).

2) "extract" — the user wants an EXACT time slice ("first 30 seconds",
   "from 0:30 to 1:30", "last minute").
   {
     "mode": "extract",
     "extractRange": { "kind": "first|last|absolute", "startSeconds": N, "endSeconds": N },
     "message": "one short sentence"
   }
   - "first 30 seconds" -> kind:"first", start:0, end:30.
   - "last minute" -> kind:"last", start:0, end:60 (caller resolves from duration).
   - "0:30 to 1:30" -> kind:"absolute", start:30, end:90.

3) "clarify" — ONLY when there is genuinely no subject and no time slice.
   {
     "mode": "clarify",
     "questions": [{ "id": "topic", "prompt": "short question", "suggestions": ["a","b","c"], "kind": "single-choice" }],
     "message": "one short question"
   }
   - Prefer "plan" with a best-effort scenario over clarify. Clarify is a
     last resort.

Rules:
- Times are SECONDS as numbers.
- Never invent timestamps beyond the video duration given in context.
- Keep "message" to one short sentence.`;

/**
 * Build the user-turn payload. Token-lean: latest user message, a couple
 * of prior turns for context, video duration, and the frame-tree outline
 * when available (so the model grounds scenarios in what's actually in
 * the footage).
 */
export function buildLocalPlannerUserPrompt(
  messages: LocalChatMessage[],
  context?: LocalPlannerContext
): string {
  const lines: string[] = [];

  if (context?.videoMeta?.duration) {
    lines.push(`VIDEO DURATION: ${Math.round(context.videoMeta.duration)}s`);
  }
  if (typeof context?.highlightsCount === "number") {
    lines.push(`TIMELINE CLIPS: ${context.highlightsCount}`);
  }
  if (context?.treeOutline) {
    lines.push("FOOTAGE OUTLINE:");
    lines.push(context.treeOutline);
  }

  // Include up to the last 4 turns for minimal conversational context.
  const recent = messages.slice(-4);
  if (recent.length > 0) {
    lines.push("CONVERSATION:");
    for (const m of recent) {
      if (m.role === "system") continue;
      const who = m.role === "user" ? "USER" : "ASSISTANT";
      lines.push(`${who}: ${m.content.slice(0, 400)}`);
    }
  }

  lines.push("");
  lines.push("Return the single JSON object now.");
  return lines.join("\n");
}

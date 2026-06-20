// =====================================================================
// lib/analysis/globalPlanRequest.ts
//
// PURE: derive the multi-video GlobalPlanRequest (style / best-only) from
// the user's text + the already-classified prompt specificity. Generic
// output vocabulary only (story vs montage vs best-only) — NOT a genre
// table. Feeds lib/analysis/globalVideoPlanner.planGlobalEdit.
//
// PURE: imports types only. Unit-tested.
// =====================================================================

import type { PromptSpecificity } from "./types";
import type { GlobalPlanRequest } from "./globalVideoPlanner";

const STORY = /\b(story|storyline|narrative|cinematic|journey|trailer|documentary|emotional|build\s*up)\b/i;
const MONTAGE = /\b(montage|fast\s*cuts?|quick\s*cuts?|fast[- ]?paced|rapid|snappy|hype|energetic)\b/i;
const BEST_ONLY =
  /\b(best\s+(?:only|parts?\s+only)|only\s+the\s+best|most\s+action|just\s+the\s+best|top\s+moments?\s+only|strongest\s+(?:bits|parts))\b/i;

/**
 * Derive the request the global planner reasons over. When the user named a
 * style we honor it; when they asked for best-only we let the strongest
 * source lead; otherwise style stays "unknown" so the planner can ask (for a
 * vague brief) or default to balanced.
 */
export function deriveGlobalPlanRequest(
  text: string,
  promptSpecificity: PromptSpecificity
): GlobalPlanRequest {
  const s = (text ?? "").toLowerCase();
  const bestOnly = BEST_ONLY.test(s);
  let style: GlobalPlanRequest["style"] = "unknown";
  if (STORY.test(s)) style = "story";
  else if (MONTAGE.test(s)) style = "montage";
  return { promptSpecificity, style, bestOnly };
}

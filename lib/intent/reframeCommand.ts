// =====================================================================
// lib/intent/reframeCommand.ts
//
// Deterministic detector for FRAMING/reframe talk ("not fixed center",
// "make it dynamic", "follow the action", "does it always center?").
//
// Smart-reframe is already automatic (v2.7): for vertical/square output the
// crop follows each clip's motion/subject focal point and only sits center
// when the frame is flat. There's no per-edit on/off, so this layer's job is
// to RECOGNIZE framing intent and answer honestly instead of letting the
// words become a content search.
//
// Anchored to framing-ONLY turns (tight length bounds) so a create request
// that merely mentions framing ("3 min reel of the fight, dynamic reframe")
// is NOT caught — that flows to the planner, which auto-reframes anyway.
//
// PURE + dependency-free. Unit-tested. Generic editing vocabulary, NO
// content/genre table.
// =====================================================================

export type ReframeIntent = { wants: "dynamic" | "center" | "explain" };

export function parseReframeIntent(text: string): ReframeIntent | null {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return null;
  const wordCount = t.split(/\s+/).length;

  // A question about how cropping/framing behaves.
  if (
    wordCount <= 12 &&
    /\b(how|does|do you|will it|is it|why)\b/.test(t) &&
    /\b(re-?fram\w*|crop\w*|framing|cent(?:er|re)\w*)\b/.test(t)
  ) {
    return { wants: "explain" };
  }

  // Wants dynamic / not-fixed-center. Framing-only (tight bounds around the
  // phrase) so long create requests don't match.
  if (
    /^.{0,45}?\b(not\s+(?:only\s+)?(?:fixed\s+)?cent(?:er|re)|don'?t\s+(?:just\s+|always\s+)?cent(?:er|re)|stop\s+centering|dynamic\s+(?:crop|reframe|re-?frame|framing|cropping)|(?:smart|auto)\s*-?\s*reframe|follow\s+the\s+(?:action|subject|player|character)|stay\s+on\s+(?:the\s+)?(?:subject|action|player|character)|keep\s+(?:the\s+)?(?:subject|action|him|her|it|player|character)\s+in\s+(?:the\s+)?frame)\b.{0,45}$/.test(
      t
    )
  ) {
    return { wants: "dynamic" };
  }

  // Wants a locked/fixed center crop.
  if (
    /^.{0,35}?\b(fixed\s+cent(?:er|re)|lock(?:ed)?\s+cent(?:er|re)|keep\s+it\s+cent(?:er|re)ed|always\s+cent(?:er|re)|cent(?:er|re)\s+crop|just\s+cent(?:er|re))\b.{0,35}$/.test(
      t
    )
  ) {
    return { wants: "center" };
  }

  return null;
}

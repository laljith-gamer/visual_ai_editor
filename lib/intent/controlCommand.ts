// =====================================================================
// lib/intent/controlCommand.ts
//
// MINIMAL safe control-command classifier — the ONLY regex that survives.
//
// These 4 patterns match ONLY whole-message, short utterances for commands
// that must NEVER reach an AI model: undo, redo, render, export. They are
// safe because they are unambiguous, state-free, and a false positive has
// zero cost (the user just types again).
//
// Everything else — including "yes", "no", "cancel", format changes,
// source switching, transitions, editing commands — goes through the AI
// intent router which understands them in context.
//
// Pure + dependency-free → instant (<1ms).
// =====================================================================

export type ControlAction = "undo" | "redo" | "render" | "export";

export interface ControlCommand {
  action: ControlAction;
  matchedText: string;
}

// Anchored (^...$), case-insensitive, allowing trailing punctuation/space.
// Each pattern covers ONLY the bare command + minimal natural variations.

const UNDO_RE =
  /^(?:undo|undo that|undo it|undo last|revert|go back)[\s.!?]*$/i;

const REDO_RE =
  /^(?:redo|redo that|redo it)[\s.!?]*$/i;

const RENDER_RE =
  /^(?:render|render it|render the video|finish it)[\s.!?]*$/i;

const EXPORT_RE =
  /^(?:export|export it|download|download it|save it)[\s.!?]*$/i;

/**
 * Classify a turn as a bare control command, or null.
 *
 * This is intentionally TINY — only 4 patterns, only whole-message matches,
 * only commands that are unambiguous without any context. Everything else
 * goes to the AI router.
 */
export function classifyControlCommand(text: string): ControlCommand | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  // Guard: only short utterances (≤4 words). Anything longer carries
  // intent that the AI router should understand.
  if (trimmed.split(/\s+/).length > 4) return null;

  if (UNDO_RE.test(trimmed)) return { action: "undo", matchedText: trimmed };
  if (REDO_RE.test(trimmed)) return { action: "redo", matchedText: trimmed };
  if (EXPORT_RE.test(trimmed)) return { action: "export", matchedText: trimmed };
  if (RENDER_RE.test(trimmed)) return { action: "render", matchedText: trimmed };
  return null;
}

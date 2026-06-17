/**
 * Phase 1 (offline) — fast command classifier.
 *
 * Catches the tiny set of "control" utterances that must NEVER reach the
 * AI planner: confirmations, cancellations, undo/redo, and render/export.
 * Without this, "yes do it" became "look for yes moments" and "undo"
 * became "look for undo moments" once they fell through to the planner.
 *
 * Matching is ANCHORED to the WHOLE (trimmed) message (`^…$`), so partial
 * commands like "go to clip 2" or "render the part where he scores" do
 * NOT misfire as bare "go" / "render" — those carry real edit intent and
 * flow on to the command parser. This keeps false positives near zero.
 *
 * Pure + dependency-free → instant (<1ms) and unit-testable in isolation.
 * The ROUTER (lib/agent/runAgentCommand.ts) decides what each kind does
 * given the current pending/timeline state; this module only classifies.
 */

export type FastCommandKind = "affirm" | "cancel" | "undo" | "redo" | "render";

export interface FastCommand {
  kind: FastCommandKind;
  matchedText: string;
}

// Whole-message, case-insensitive, allowing trailing punctuation/space.
const UNDO_RE =
  /^(?:undo|undo that|undo it|undo last|undo the last( edit| change)?|revert|revert that|go back|put it back|take it back|bring (?:it|that|them) back)\b[\s.!?]*$/i;

const REDO_RE = /^(?:redo|redo that|redo it|reapply( that)?)\b[\s.!?]*$/i;

const RENDER_RE =
  /^(?:render|export|render it|export it|render (?:this|the (?:video|short|reel|clip|timeline))|export (?:this|the (?:video|short|reel|clip|timeline))|make the (?:video|short|reel)|finish( it)?|assemble( it)?)\b[\s.!?]*$/i;

const AFFIRM_RE =
  /^(?:y|ya|yes|yeah|yep|yup|yes please|ok|okay|k|kk|sure|alright|fine|cool|great|perfect|sounds good|do it|go|go ahead|go for it|go on|run|run it|let'?s go|please do|please proceed|proceed|confirm|continue|yes do it|ok do it|okay do it|do that|make it so)\b[\s.!?]*$/i;

const CANCEL_RE =
  /^(?:no|nope|nah|no thanks|cancel|cancel that|stop|never ?mind|forget it|scrap that|scrap it|abort|don'?t|do not|leave it|not now)\b[\s.!?]*$/i;

/**
 * Classify a turn into a fast control command, or null when it isn't one
 * (so the caller routes it to the direct command parser / planner).
 *
 * Order matters: undo / redo / render are checked before affirm / cancel
 * so "undo" is never treated as a generic cancel.
 */
export function classifyFastCommand(text: string): FastCommand | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  // Guard: keep it to short utterances. Anything longer than ~6 words is
  // very unlikely to be a bare control command and may carry edit intent.
  if (trimmed.split(/\s+/).length > 6) return null;

  if (UNDO_RE.test(trimmed)) return { kind: "undo", matchedText: trimmed };
  if (REDO_RE.test(trimmed)) return { kind: "redo", matchedText: trimmed };
  if (RENDER_RE.test(trimmed)) return { kind: "render", matchedText: trimmed };
  if (AFFIRM_RE.test(trimmed)) return { kind: "affirm", matchedText: trimmed };
  if (CANCEL_RE.test(trimmed)) return { kind: "cancel", matchedText: trimmed };
  return null;
}

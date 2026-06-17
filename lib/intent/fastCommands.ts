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

export type FastCommandKind = "affirm" | "cancel" | "undo" | "redo" | "render" | "export";

export interface FastCommand {
  kind: FastCommandKind;
  matchedText: string;
}

// Whole-message, case-insensitive, allowing trailing punctuation/space.
const UNDO_RE =
  /^(?:undo|undo that|undo it|undo last|undo the last( edit| change)?|revert|revert that|go back|put it back|take it back|bring (?:it|that|them) back)\b[\s.!?]*$/i;

const REDO_RE = /^(?:redo|redo that|redo it|reapply( that)?)\b[\s.!?]*$/i;

// Render = assemble the timeline into a video (no download).
const RENDER_RE =
  /^(?:render|render it|render (?:this|the (?:video|short|reel|clip|timeline))|make the (?:video|short|reel)|finish( it)?|assemble( it)?)\b[\s.!?]*$/i;

// Export = save/download the ALREADY-rendered short. Kept distinct from
// render so "export" downloads (or says "render first") rather than
// silently re-rendering.
const EXPORT_RE =
  /^(?:export|export it|download|download it|save (?:it|the (?:video|short|reel|clip|file))|export (?:this|the (?:video|short|reel|clip)))\b[\s.!?]*$/i;

const AFFIRM_RE =
  /^(?:y|ya|yes|yeah|yep|yup|yes please|ok|okay|k|kk|sure|alright|fine|cool|great|perfect|sounds good|do it|go|go ahead|go for it|go on|run|run it|let'?s go|please do|please proceed|proceed|confirm|continue|yes do it|ok do it|okay do it|do that|make it so)\b[\s.!?]*$/i;

const CANCEL_RE =
  /^(?:no|nope|nah|no thanks|cancel|cancel that|stop|never ?mind|forget it|scrap that|scrap it|abort|don'?t|do not|leave it|not now)\b[\s.!?]*$/i;

/**
 * Classify a turn into a fast control command, or null when it isn't one
 * (so the caller routes it to the direct command parser / planner).
 *
 * Order matters: undo / redo / export / render are checked before affirm /
 * cancel so "undo" is never treated as a generic cancel, and "export the
 * video" matches export rather than render.
 */
export function classifyFastCommand(text: string): FastCommand | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  // Guard: keep it to short utterances. Anything longer than ~6 words is
  // very unlikely to be a bare control command and may carry edit intent.
  if (trimmed.split(/\s+/).length > 6) return null;

  if (UNDO_RE.test(trimmed)) return { kind: "undo", matchedText: trimmed };
  if (REDO_RE.test(trimmed)) return { kind: "redo", matchedText: trimmed };
  if (EXPORT_RE.test(trimmed)) return { kind: "export", matchedText: trimmed };
  if (RENDER_RE.test(trimmed)) return { kind: "render", matchedText: trimmed };
  if (AFFIRM_RE.test(trimmed)) return { kind: "affirm", matchedText: trimmed };
  if (CANCEL_RE.test(trimmed)) return { kind: "cancel", matchedText: trimmed };
  return null;
}

/** State the router knows when deciding what a fast command should do. */
export interface FastActionState {
  /** A plan/run is queued awaiting a yes/no. */
  pendingExecution: boolean;
  /** A clarify question is awaiting a reply. */
  pendingClarify: boolean;
  /** Number of clips on the timeline. */
  highlightCount: number;
  /** Whether a rendered short blob exists (export target). */
  hasRenderedBlob: boolean;
}

/**
 * The resolved action for a fast command given current state. Pure +
 * exhaustive so the routing decisions are unit-testable without the store:
 *   - "delegate"          → affirm/cancel WITH a pending action: hand to
 *                            the existing quick-shortcut gate.
 *   - "nudge_affirm"      → "yes" with nothing pending (never a search).
 *   - "nudge_cancel"      → "cancel" with nothing pending.
 *   - "undo" / "redo"     → call the store directly (never the planner).
 *   - "render"            → real render path (clips exist).
 *   - "render_empty"      → ask to add clips first.
 *   - "export"            → download the rendered short.
 *   - "export_no_render"  → "render first".
 */
export type FastAction =
  | "delegate"
  | "nudge_affirm"
  | "nudge_cancel"
  | "undo"
  | "redo"
  | "render"
  | "render_empty"
  | "export"
  | "export_no_render";

export function decideFastAction(kind: FastCommandKind, state: FastActionState): FastAction {
  switch (kind) {
    case "undo":
      return "undo";
    case "redo":
      return "redo";
    case "render":
      return state.highlightCount > 0 ? "render" : "render_empty";
    case "export":
      return state.hasRenderedBlob ? "export" : "export_no_render";
    case "affirm":
      return state.pendingExecution || state.pendingClarify ? "delegate" : "nudge_affirm";
    case "cancel":
      return state.pendingExecution || state.pendingClarify ? "delegate" : "nudge_cancel";
    default:
      return "delegate";
  }
}

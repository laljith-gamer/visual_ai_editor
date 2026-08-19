import { PLANNER_SYSTEM_PROMPT } from "./prompts/index";
export { PLANNER_SYSTEM_PROMPT };

import type {
  ChatMessage,
  EditPlan,
  MemoryFact,
  SessionMemory,
  VideoLibraryEntry
} from "@/lib/types";
import { buildMemoryBlock } from "@/lib/memory/inject";
import { CONVERSATION } from "@/lib/config";

/**
 * Conversational planner prompt.
 *
 * The LLM does ALL intent understanding — there are no regex or keyword
 * heuristics anywhere on the server. The model reads the latest user
 * message together with the conversation history, the session memory,
 * the current plan, the source video metadata, and any recent activity,
 * then chooses ONE mode (plan / moment / extract / acknowledge / clarify)
 * and emits a single JSON object that the server validates and forwards
 * to the client.
 *
 * Output contract — one JSON object, no markdown fences:
 *
 *   {
 *     "mode":      "plan" | "moment" | "extract" | "acknowledge" | "clarify",
 *     "message":   "<one short, warm sentence the user will read>",
 *     "userTier":  "novice" | "advanced",      // omit for acknowledge / clarify
 *     "inferred":  [{ "field": "...", "value": ..., "reason": "..." }, ...],
 *
 *     // mode-specific:
 *     "plan":              EditPlan          (plan mode, fresh; or moment mode)
 *     "planPatch":         Partial<EditPlan> (plan mode, refinement)
 *     "momentDescription": "<verbatim user description>"  (moment mode)
 *     "extractRange":      { kind, startSeconds, endSeconds, spoken }  (extract mode)
 *     "questions":         ClarifyQuestion[] (clarify mode)
 *
 *     // v1.7.0 — universal output, allowed on every mode:
 *     "factsToRemember": [{ "subject": "...", "value": ...,
 *                            "kind": "intent"|"preference"|...,
 *                            "source": "explicit"|"inferred"|"feedback",
 *                            "confidence": 0..1,
 *                            "reason": "..." }, ...]
 *   }
 *
 * Golden rule: NEVER crash, ALWAYS make progress. Every turn either
 * advances the plan or asks one focused question. When in doubt about
 * a turn's intent, prefer "acknowledge" or "clarify" over guessing —
 * we never want to overwrite a working plan because the user just
 * told us a fact about the footage.
 */



/** Build the user-facing turn payload. */
export function buildPlannerUserPrompt(args: {
  messages: ChatMessage[];
  currentPlan: EditPlan | null;
  videoMeta?: { duration: number; width: number; height: number };
  /** v1.6.0 — full library; takes precedence over `videoMeta` for the
   *  context block. */
  videoLibrary?: VideoLibraryEntry[];
  /** v1.6.1 — id of the source currently active in the preview pane.
   *  Tells the LLM which one "this video" / "this clip" refers to. */
  activeSourceId?: string;
  /** v1.6.1 — number of clips currently on the timeline. The LLM uses
   *  this to choose between "edit" and "extract" for time-bound asks. */
  highlightsCount?: number;
  /** v1.6.1 — id of the clip the user has selected on the timeline.
   *  Lets "split this clip" / "drop the selected clip" resolve cleanly. */
  selectedClipId?: string | null;
  /** v1.6.4 — full clip listing so the LLM can map "clip 2" / "this
   *  clip" to a clipId for describe/edit modes. Indexed in display
   *  order on the timeline. */
  highlights?: Array<{
    id: string;
    start: number;
    end: number;
    sourceId?: string;
    label?: string;
  }>;
  memory?: SessionMemory;
  /** v1.7.0 — persistent memory facts retrieved from this user's
   *  session. Rendered as a "What I remember" block above the rest of
   *  the context. The planner is told these are soft truths. */
  facts?: MemoryFact[];
  /** Optional summary of recent activity events. See lib/log/summarize.ts. */
  recentActivity?: string;
  /** v1.7.2 — most recent briefing (when in scope). Rendered as an
   *  authoritative list of best parts the user has already seen, so
   *  the planner can emit `mode: "promote"` when they say "clip
   *  those", "use the second one", etc. */
  lastBriefing?: {
    sourceId: string;
    sourceName?: string;
    bestParts: Array<{
      id: string;
      startSeconds: number;
      endSeconds: number;
      label: string;
      why: string;
    }>;
  };
}): string {
  const lines: string[] = [];

  // --- Memory facts (v1.7.0) ----------------------------------------
  // Place this FIRST so it sets the soft-truth context the planner
  // reads everything else against.
  if (args.facts && args.facts.length > 0) {
    const block = buildMemoryBlock(args.facts);
    if (block) {
      lines.push(block);
      lines.push("");
    }
  }

  // --- Source / library context -------------------------------------
  if (args.videoLibrary && args.videoLibrary.length > 0) {
    const lib = args.videoLibrary;
    const selectedCount = lib.filter((s) => s.selected).length;
    lines.push(
      `Video library: ${lib.length} source${lib.length === 1 ? "" : "s"} ` +
        `(${selectedCount} selected for AI use).`
    );
    for (const s of lib) {
      const aspect = s.aspect ?? (s.width && s.height ? (s.width / s.height).toFixed(2) : "?");
      const flag = s.selected ? "selected" : "skip";
      const activeFlag = args.activeSourceId === s.id ? ", ACTIVE" : "";
      const notes =
        s.notes && s.notes.length > 0
          ? ` notes=[${s.notes.slice(0, 4).join(" | ").slice(0, 200)}]`
          : "";
      lines.push(
        `  - ${s.id} "${s.name}" \u2014 ${Math.round(s.duration)}s, ${s.width}\u00d7${s.height}, aspect ${aspect}, ${flag}${activeFlag}.${notes}`
      );
    }
  } else if (args.videoMeta) {
    const w = args.videoMeta.width;
    const h = args.videoMeta.height;
    const aspect = w && h ? (w / h).toFixed(2) : "?";
    lines.push(
      `Source video: ${Math.round(args.videoMeta.duration)}s, ${w}\u00d7${h}, aspect ${aspect}.`
    );
  } else {
    lines.push("Source video: not yet uploaded.");
  }

  // --- Timeline state (drives edit vs extract decision) ------------
  if (typeof args.highlightsCount === "number") {
    lines.push(
      `Highlights on timeline: ${args.highlightsCount}` +
        (args.selectedClipId ? ` (selected: ${args.selectedClipId})` : "")
    );
  }
  // v1.6.4 — list each clip with index + range so the LLM can resolve
  // "clip 2", "the third clip", "this clip" to a real clipId for
  // describe / edit / split-selected operations. Capped at 12 entries
  // to keep the prompt small; if the user has more clips, naming "clip
  // 13+" is rare enough that we accept the trade-off.
  if (args.highlights && args.highlights.length > 0) {
    const cap = 12;
    const list = args.highlights.slice(0, cap);
    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      const sid = h.sourceId ? ` (source ${h.sourceId})` : "";
      const lbl = h.label ? ` "${h.label.slice(0, 40)}"` : "";
      lines.push(
        `  clip ${i + 1}: id=${h.id} ${h.start.toFixed(1)}s\u2013${h.end.toFixed(1)}s${sid}${lbl}`
      );
    }
    if (args.highlights.length > cap) {
      lines.push(`  \u2026 ${args.highlights.length - cap} more clips not shown`);
    }
  }

  // --- Memory --------------------------------------------------------
  if (args.memory) {
    const m = args.memory;
    const memLines: string[] = [];
    if (m.duration) memLines.push(`duration=${m.duration}s`);
    if (m.format) memLines.push(`format=${m.format}`);
    if (m.styles?.length) memLines.push(`styles=${m.styles.join(",")}`);
    if (m.keep?.length) memLines.push(`keep=${m.keep.join(",")}`);
    if (m.skip?.length) memLines.push(`skip=${m.skip.join(",")}`);
    if (memLines.length) lines.push(`Session memory: ${memLines.join("; ")}.`);
  }

  // --- Current plan --------------------------------------------------
  if (args.currentPlan) {
    // Report duration HONESTLY: only show a concrete target when the user
    // actually named one. Otherwise say "flexible" so the planner doesn't
    // mistake the soft fallback (e.g. 30) for a user preference on a
    // refinement turn.
    const durationStr = args.currentPlan.userSpecifiedDuration
      ? `target=${args.currentPlan.targetShortSeconds}s (user-set)`
      : "target=flexible (no user-set duration)";
    lines.push(
      `Current plan: ${durationStr}, format=${args.currentPlan.format}, transition=${args.currentPlan.transition}, scenarios=[${args.currentPlan.scenarios
        .map((s) => `${s.id}:"${s.prompt}"`)
        .join("; ")}].`
    );
  } else {
    lines.push("Current plan: none (this is the first plan).");
  }

  // --- Recent activity (implicit memory) ----------------------------
  if (args.recentActivity && args.recentActivity.trim()) {
    lines.push("");
    lines.push(args.recentActivity.trim());
  }

  // --- Conversation history -----------------------------------------
  const history = args.messages.slice(-CONVERSATION.maxHistoryTurns * 2);
  if (history.length > 1) {
    lines.push("");
    lines.push("Conversation so far (oldest first):");
    for (const m of history.slice(0, -1)) {
      const truncated =
        m.content.length > CONVERSATION.maxMessageChars
          ? m.content.slice(0, CONVERSATION.maxMessageChars) + "\u2026"
          : m.content;
      lines.push(`  [${m.role}] ${truncated}`);
    }
  }

  // --- Current user turn --------------------------------------------
  // --- Last briefing (v1.7.2) ---------------------------------------
  // When the user has just received a briefing card, surface its best
  // parts as authoritative context. The planner can emit
  // `mode: "promote"` to convert these directly into clips without
  // re-running vision. Each part has a stable id, start/end on the
  // active source, and the briefing's own one-line "why".
  if (
    args.lastBriefing &&
    args.lastBriefing.bestParts &&
    args.lastBriefing.bestParts.length > 0
  ) {
    const lb = args.lastBriefing;
    lines.push(
      `Last briefing best parts (eligible for "promote" mode \u2014 the user has already seen these in chat):`
    );
    if (lb.sourceName) {
      lines.push(`  Source: "${lb.sourceName}" (id: ${lb.sourceId})`);
    }
    for (let i = 0; i < lb.bestParts.length; i++) {
      const p = lb.bestParts[i];
      const dur = (p.endSeconds - p.startSeconds).toFixed(1);
      lines.push(
        `  ${(i + 1).toString().padStart(2, "0")}. id=${p.id} ${formatTime(p.startSeconds)}\u2013${formatTime(p.endSeconds)} (${dur}s) — ${p.label}`
      );
    }
    lines.push("");
  }

  const latest = args.messages[args.messages.length - 1];
  const userText = latest?.role === "user" ? latest.content : "";
  lines.push("");
  lines.push("Current user turn:");
  lines.push(`<user_request>\n${userText}\n</user_request>`);

  return lines.join("\n");
}


/** v1.7.2 — Format seconds as mm:ss for the lastBriefing block in the
 *  planner prompt. Mirrors the formatT helper used in editor chat
 *  copy; kept local so prompt.ts has zero runtime dependencies. */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

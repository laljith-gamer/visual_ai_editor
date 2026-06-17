/**
 * Offline question answerer (PR — question routing fix).
 *
 * The reported bug: questions like "describe what's in this video" or
 * "why did you pick these clips, explain it" fell through the command
 * gate to the planner, which turned the question WORDS into scenarios
 * ("describe moments", "tell and why and did and explain moments") and
 * BUILT a short. That is wrong on every axis.
 *
 * This module answers such turns DETERMINISTICALLY and OFFLINE from the
 * editor's OWN data — clip reasons/scores, boundary transitions, the
 * local transcript, and source metadata — and NEVER builds a short. It is
 * pure (no imports) so it is unit-testable; the runner builds the context
 * from the store and pushes the answer.
 *
 * It is conservative: `classifyQuestion` only fires on clear question /
 * explanation intent. Anything else returns null and flows on to the
 * normal command/plan path, so real build requests ("pick best parts")
 * are untouched.
 */

export type QuestionKind =
  | "explain_picks"
  | "describe_video"
  | "timeline_status"
  | "transitions_status"
  | "capabilities";

export interface QAClip {
  id: string;
  start: number;
  end: number;
  sourceId?: string;
  label?: string;
  reason?: string;
  score?: number;
  confidence?: "high" | "medium" | "low";
}

export interface QABoundary {
  index: number;
  type: string;
  mode?: "auto" | "manual";
  reason?: string;
  render?: string;
  exact?: boolean;
  note?: string;
}

export interface QASource {
  id: string;
  name: string;
  duration: number;
  width?: number;
  height?: number;
}

export interface QAContext {
  highlights: QAClip[];
  boundaryTransitions: QABoundary[];
  sources: QASource[];
  activeSourceId: string | null;
  /** Joined transcript text for the active source, when available. */
  transcriptText: string | null;
  hasTranscript: boolean;
}

/**
 * Classify a turn as a question we can answer offline, or null (→ flow on
 * to the command/plan path). Order: most specific first.
 */
export function classifyQuestion(text: string): QuestionKind | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  const t = raw.toLowerCase();

  const isQuestionShape =
    raw.includes("?") ||
    /\b(why|what|whats|what's|how|describe|explain|tell\s+me|summar(y|ise|ize)|reason|list|which)\b/.test(t);

  // "what can you do" / "help" — capability ask.
  if (/\b(what can you do|what do you do|how do (i|you)|help me|what are you able)\b/.test(t)) {
    return "capabilities";
  }

  // Transition-specific question ("why crossfade", "what transitions did you
  // pick", "why a fade between clip 1 and 2"). Checked before explain_picks
  // because these mention clips too.
  const mentionsTransition =
    /\btransitions?\b/.test(t) ||
    /\b(crossfade|dip\s*to\s*black|match\s*cut)\b/.test(t) ||
    (/\bbetween\s+clips?\b/.test(t) && /\b(fade|cut|crossfade|dip|slide|zoom|glitch|whip)\b/.test(t));
  if (mentionsTransition && isQuestionShape) {
    return "transitions_status";
  }

  // "why did you pick / choose these clips", "explain the clips", "explain it".
  const refersToPicks =
    /\b(pick|picked|choose|chose|chosen|select|selected|selection|clips?|cuts?|parts?|moments?|them|these|those|it)\b/.test(t);
  if (
    (/\b(why|explain|reason|justify|how come)\b/.test(t) && refersToPicks) ||
    /^(explain|why)\b/.test(t)
  ) {
    return "explain_picks";
  }

  // "describe / what's in this video", "summarize the video", "what happens".
  if (
    /\b(describe|summar(y|ise|ize)|what happens|what'?s happening)\b/.test(t) ||
    /\bwhat(?:'?s| is)\b.*\b(in|about|this|the)\b.*\b(video|footage|clip|reel|source)\b/.test(t) ||
    /\b(what is this|whats this)\b/.test(t)
  ) {
    return "describe_video";
  }

  // "what clips do I have", "show me the timeline", "how many clips", "how long".
  if (
    isQuestionShape &&
    /\b(clips?|timeline|reel|short)\b/.test(t) &&
    /\b(what|how many|how long|list|show|do i have|on the)\b/.test(t)
  ) {
    return "timeline_status";
  }

  return null;
}

export interface QAAnswer {
  message: string;
  kind: QuestionKind;
}

export function answerQuestion(kind: QuestionKind, ctx: QAContext): QAAnswer {
  switch (kind) {
    case "explain_picks":
      return { kind, message: explainPicks(ctx) };
    case "describe_video":
      return { kind, message: describeVideo(ctx) };
    case "timeline_status":
      return { kind, message: timelineStatus(ctx) };
    case "transitions_status":
      return { kind, message: transitionsStatus(ctx) };
    case "capabilities":
      return { kind, message: capabilities(ctx) };
    default:
      return { kind, message: capabilities(ctx) };
  }
}

// ---------------------------------------------------------------------
// Answer builders
// ---------------------------------------------------------------------

function explainPicks(ctx: QAContext): string {
  const clips = ctx.highlights;
  if (clips.length === 0) {
    return "There aren't any clips on the timeline yet, so there's nothing to explain. Tell me what to look for (e.g. \u201cpick the best parts\u201d) and I'll pick clips and explain each choice.";
  }
  const total = clips.reduce((s, c) => s + Math.max(0, c.end - c.start), 0);
  const lines = clips.slice(0, 14).map((c, i) => {
    const src = sourceName(ctx, c.sourceId);
    const why = c.reason || c.label || "selected as a strong moment";
    const meta: string[] = [];
    if (typeof c.score === "number") meta.push(`score ${round2(c.score)}`);
    if (c.confidence) meta.push(`${c.confidence} confidence`);
    const metaStr = meta.length ? ` (${meta.join(", ")})` : "";
    return `${i + 1}. ${fmt(c.start)}\u2013${fmt(c.end)}${src ? ` \u00b7 ${src}` : ""} \u2014 ${why}${metaStr}`;
  });
  const more = clips.length > 14 ? `\n\u2026and ${clips.length - 14} more.` : "";
  return (
    `I picked ${clips.length} clip${clips.length === 1 ? "" : "s"} (${fmt(total)} total). Here's why each one is on the timeline:\n` +
    lines.join("\n") +
    more +
    `\n\nWant changes? Say e.g. \u201cremove clip 2\u201d, \u201cmore like clip 3\u201d, or \u201cnot this\u201d and I'll re-pick.`
  );
}

function describeVideo(ctx: QAContext): string {
  const src =
    ctx.sources.find((s) => s.id === ctx.activeSourceId) ?? ctx.sources[0] ?? null;
  if (!src) {
    return "Upload a video first \u2014 then I can tell you about it. Your video stays on this device.";
  }
  const dims = src.width && src.height ? `, ${src.width}\u00d7${src.height}` : "";
  const head = `\u201c${src.name}\u201d (${fmt(src.duration)}${dims}).`;

  if (ctx.hasTranscript && ctx.transcriptText && ctx.transcriptText.trim()) {
    const keywords = topKeywords(ctx.transcriptText, 8);
    const opening = firstSentences(ctx.transcriptText, 220);
    return (
      `Here's what I can tell from the spoken transcript of ${head}\n` +
      (keywords.length ? `Main topics: ${keywords.join(", ")}.\n` : "") +
      (opening ? `It opens with: \u201c${opening}\u201d\n` : "") +
      `\nI read the speech locally \u2014 I haven't visually analysed the frames (that needs visual analysis enabled). Ask me to \u201cfind the part where they say \u2026\u201d and I'll clip it from the transcript.`
    );
  }

  return (
    `${head}\nYour video stays on this device, so I can only describe it from data I have locally. There's no transcript yet and I haven't visually analysed the frames offline, so I can't honestly summarise the content.\n\nTo get a real description: enable transcription (so I can read the speech), then ask again \u2014 or ask me to \u201cpick the best parts\u201d and I'll analyse the footage and explain each clip.`
  );
}

function timelineStatus(ctx: QAContext): string {
  const clips = ctx.highlights;
  if (clips.length === 0) {
    return "Your timeline is empty. Add a clip (e.g. \u201cadd first 10 seconds\u201d) or ask me to \u201cpick the best parts\u201d.";
  }
  const total = clips.reduce((s, c) => s + Math.max(0, c.end - c.start), 0);
  const lines = clips.slice(0, 20).map((c, i) => {
    const src = sourceName(ctx, c.sourceId);
    return `${i + 1}. ${fmt(c.start)}\u2013${fmt(c.end)} (${round1(c.end - c.start)}s)${src ? ` \u00b7 ${src}` : ""}${c.label ? ` \u2014 ${c.label}` : ""}`;
  });
  const more = clips.length > 20 ? `\n\u2026and ${clips.length - 20} more.` : "";
  return (
    `You have ${clips.length} clip${clips.length === 1 ? "" : "s"} on the timeline, ${fmt(total)} total:\n` +
    lines.join("\n") +
    more
  );
}

function transitionsStatus(ctx: QAContext): string {
  const bts = [...ctx.boundaryTransitions].sort((a, b) => a.index - b.index);
  if (ctx.highlights.length < 2) {
    return "There aren't enough clips for transitions yet \u2014 add at least 2 clips, then I'll pick transitions between them automatically.";
  }
  if (bts.length === 0) {
    return "No transitions are set yet. Say \u201cauto pick transitions\u201d and I'll choose one for each boundary and explain why.";
  }
  const lines = bts.map((b) => {
    const a = b.index;
    const c = b.index + 1;
    const label = capitalize(b.type.replace(/_/g, " "));
    const why = b.reason ? ` \u2014 ${b.reason}` : "";
    const mapped = b.exact === false && b.note ? ` (${b.note})` : "";
    const mode = b.mode === "manual" ? " [you set this]" : "";
    return `${a}\u2192${c} ${label}${mode}${why}${mapped}`;
  });
  return `Transitions (${bts.length}):\n${lines.join("\n")}`;
}

function capabilities(ctx: QAContext): string {
  void ctx;
  return (
    "I'm your offline editor \u2014 here's what I can do without any cloud or GPU:\n" +
    "\u2022 Add clips by time: \u201cadd first 10 seconds\u201d, \u201cadd 0:30 to 1:00\u201d\n" +
    "\u2022 Edit: remove / move / trim clips, undo, redo\n" +
    "\u2022 Pick best parts and explain each choice (ask \u201cwhy these clips\u201d)\n" +
    "\u2022 Auto-pick transitions and explain them (\u201cauto pick transitions\u201d)\n" +
    "\u2022 Render and export an MP4\n" +
    "If you enable transcription I can also find spoken moments and describe the speech. Your video never leaves this device."
  );
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function sourceName(ctx: QAContext, sourceId?: string): string | null {
  if (!sourceId) return null;
  return ctx.sources.find((s) => s.id === sourceId)?.name ?? null;
}

const QA_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "for", "with",
  "from", "is", "are", "was", "were", "it", "this", "that", "these", "those",
  "i", "you", "he", "she", "they", "we", "me", "my", "your", "so", "but",
  "be", "been", "as", "if", "then", "than", "there", "here", "what", "when",
  "where", "how", "why", "who", "will", "would", "can", "could", "do", "does",
  "did", "have", "has", "had", "not", "no", "yes", "just", "like", "about",
  "into", "out", "up", "down", "by", "over", "all", "im", "ive", "dont", "its"
]);

function topKeywords(text: string, n: number): string[] {
  const counts = new Map<string, number>();
  for (const w of text.toLowerCase().replace(/['’]/g, "").split(/[^a-z0-9]+/g)) {
    if (w.length < 4 || QA_STOPWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w]) => w);
}

function firstSentences(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return (lastStop > 60 ? cut.slice(0, lastStop + 1) : cut).trim() + "\u2026";
}

function fmt(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

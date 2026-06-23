// =====================================================================
// lib/agent/conversationMemory.ts
//
// Lightweight conversation memory so the assistant stops judging each turn
// in isolation:
//   - isBackReference(text)       — "do what I said before", "same as before",
//                                    "whatever I asked" … (generic phrasing,
//                                    NO content keywords / genre tables).
//   - lastSubstantiveRequest(...) — the most recent REAL user request to
//                                    re-use when the turn is a back-reference.
//   - buildConversationContext()  — a compact recent-dialogue string to feed
//                                    the on-device planner so it has context.
//
// PURE: no imports, no store access. Unit-tested.
// =====================================================================

export interface ConvoMessage {
  /** "user" | "assistant" — kept as string so the store's ChatMessage[]
   *  (which carries extra fields) is structurally assignable. */
  role: string;
  content: string;
}

/** Trivial turns that should never count as "the prior request": greetings,
 *  bare affirmations/negations, thanks. Grammar-level, not content. */
function isTrivial(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return true;
  return /^(hi|hey|hello|yo|sup|ok|okay|k|yes|yeah|yep|no|nope|nah|sure|thanks|thank you|ty|cool|nice|great|hmm+|ok cool)\b[\s.!?]*$/.test(
    t
  );
}

/**
 * True when the turn refers back to an earlier request instead of stating a
 * new one ("do what I said before", "same as before", "like I said",
 * "whatever I asked", "my previous request", "the same thing").
 */
export function isBackReference(text: string): boolean {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return false;
  if (t.split(/\s+/).length > 12) return false; // a long sentence states intent
  if (/\bwhat(?:\s*ever)?\s+i\s+(?:said|asked|told\s+you|wanted|meant|mentioned|requested)\b/.test(t)) return true;
  if (/\b(?:like|as|same\s+as)\s+(?:before|earlier|i\s+said|i\s+asked|i\s+mentioned|above)\b/.test(t)) return true;
  if (/\b(?:my|the)\s+(?:previous|earlier|last|prior)\s+(?:request|message|ask|one|prompt|instruction)\b/.test(t)) return true;
  if (/\b(?:do|use|go\s+with|repeat|redo|apply|continue\s+with)\s+(?:it|that|the\s+same|same|my\s+request)\b/.test(t) &&
      /\b(again|before|earlier|previous|like\s+i\s+said)\b/.test(t))
    return true;
  if (/^(?:the\s+)?same(?:\s+(?:thing|as\s+before|again|one))?\s*[.!]*$/.test(t)) return true;
  if (/^(?:do|go|proceed)\s+(?:it|that|with\s+that)\s+(?:again|like\s+before)\s*[.!]*$/.test(t)) return true;
  return false;
}

/** True when a turn reads like an actual editing REQUEST worth re-using (has
 *  an intent verb, a duration, or enough words) — so a fragment like "not
 *  fixed center" isn't recalled as "the prior request". Generic editing/intent
 *  vocabulary only, never content/genre words. */
function looksLikeRequest(text: string): boolean {
  const t = text.toLowerCase();
  if (
    /\b(make|create|build|generate|produce|need|want|give|show|find|pick|search|trim|cut|crop|remove|drop|add|append|merge|combine|turn|convert|render|export|keep|use|highlight|reel|short|montage)\b/.test(
      t
    )
  )
    return true;
  if (/\d+\s*(?:min|mins|minute|minutes|sec|secs|second|seconds|m|s|hr|hours?)\b/.test(t)) return true;
  return t.split(/\s+/).length >= 6;
}

/**
 * The most recent SUBSTANTIVE user request in the history — i.e. not a
 * back-reference, not a trivial greeting/affirmation, and reading like a real
 * request (not a tiny fragment). Used to recall the intent when the current
 * turn is a back-reference.
 *
 * @param exclude  the current turn's text (skip it if it's already in history)
 */
export function lastSubstantiveRequest(
  messages: ConvoMessage[],
  exclude?: string
): string | null {
  const ex = (exclude ?? "").trim();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const c = (m.content ?? "").trim();
    if (!c || c === ex) continue;
    if (isTrivial(c) || isBackReference(c)) continue;
    if (!looksLikeRequest(c)) continue;
    return c;
  }
  return null;
}

/** Compact recent-dialogue string for planner/chat prompts (newest last). */
export function buildConversationContext(
  messages: ConvoMessage[],
  limit = 6
): string {
  return messages
    .slice(-limit)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${(m.content ?? "").slice(0, 300)}`)
    .join("\n");
}

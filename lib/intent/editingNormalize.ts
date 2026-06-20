// =====================================================================
// lib/intent/editingNormalize.ts
//
// GENERIC editing-vocabulary normalization. Corrects obvious typos in the
// user's EDITING/CONTROL words and common cross-domain content-STRUCTURE
// words ("combact" → "combat", "cutsecene" → "cutscene", "trnsition" →
// "transition") so the router and downstream parsers see consistent terms.
//
// This is NOT a content dictionary. It only knows a small, extensible
// EDITOR_TURN.editingLexicon of editing/control + content-structure words.
// A token is corrected ONLY when it is within a tight Damerau-Levenshtein
// distance of exactly one lexicon word. Real CONTENT subjects the user
// types (character names, brands, topics) are never close to a lexicon word
// and are returned unchanged — so meaning is preserved, never invented.
//
// PURE: config + no runtime imports. Unit-tested.
// =====================================================================

import { EDITOR_TURN } from "../config";

/** Damerau-Levenshtein edit distance (handles single transpositions like
 *  "comabt" → "combat"). Small inputs only; O(n*m). */
export function damerauLevenshtein(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const d: number[][] = Array.from({ length: al + 1 }, () => new Array<number>(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) d[i][0] = i;
  for (let j = 0; j <= bl; j++) d[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1, // deletion
        d[i][j - 1] + 1, // insertion
        d[i - 1][j - 1] + cost // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // transposition
      }
    }
  }
  return d[al][bl];
}

const LEXICON: string[] = EDITOR_TURN.editingLexicon;
const LEXICON_SET = new Set(LEXICON);

function maxDistanceFor(tokenLen: number): number {
  return tokenLen >= EDITOR_TURN.fuzzy.longTokenLen
    ? EDITOR_TURN.fuzzy.maxDistanceLong
    : EDITOR_TURN.fuzzy.maxDistanceShort;
}

/**
 * Correct a single lowercase token to the nearest editing-lexicon word, or
 * return it unchanged. Exact lexicon words and short tokens pass through.
 * Only a UNIQUE closest lexicon word within the allowed distance wins (ties
 * are left uncorrected so we never guess between two plausible words).
 */
export function normalizeEditingToken(token: string): string {
  const t = token.toLowerCase();
  if (!t || LEXICON_SET.has(t)) return t;
  if (t.length < EDITOR_TURN.fuzzy.minTokenLenForFuzzy) return t;
  const maxDist = maxDistanceFor(t.length);

  let best: string | null = null;
  let bestDist = Infinity;
  let tied = false;
  for (const word of LEXICON) {
    // A correction should not change length by more than the allowed
    // distance — cheap prune that also avoids matching very different words.
    if (Math.abs(word.length - t.length) > maxDist) continue;
    const dist = damerauLevenshtein(t, word);
    if (dist < bestDist) {
      bestDist = dist;
      best = word;
      tied = false;
    } else if (dist === bestDist) {
      tied = true;
    }
  }
  if (best && bestDist > 0 && bestDist <= maxDist && !tied) return best;
  return t;
}

export interface EditingNormalizeResult {
  normalized: string;
  /** Per-correction notes ("combact → combat"). */
  evidence: string[];
}

/**
 * Normalize editing typos across a text, preserving punctuation-free word
 * order. Only editing/control/structure words are corrected; everything else
 * (real topics) is preserved verbatim. Operates on a lowercased copy.
 */
export function normalizeEditingText(input: string): EditingNormalizeResult {
  const evidence: string[] = [];
  const tokens = (input ?? "").toLowerCase().split(/(\s+)/); // keep whitespace
  const out = tokens.map((tok) => {
    if (/^\s+$/.test(tok) || tok === "") return tok;
    const m = tok.match(/^([a-z0-9']+)([^a-z0-9']*)$/i);
    const core = m ? m[1] : tok;
    const tail = m ? m[2] : "";
    const fixed = normalizeEditingToken(core);
    if (fixed !== core) evidence.push(`${core} \u2192 ${fixed}`);
    return fixed + tail;
  });
  return { normalized: out.join("").replace(/\s+/g, " ").trim(), evidence };
}

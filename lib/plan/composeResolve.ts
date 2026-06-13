// =====================================================================
// lib/plan/composeResolve.ts
//
// Pure source-reference resolver for multi-source COMPOSE (montage) mode.
//
// The cloud planner emits a `ComposeSourceRef` per requested source (by
// id / index / active / selected / filename hint / semantic hint). This
// module resolves each ref against the LIVE library — where ids, library
// order, the active source, and the selected set are authoritative — so a
// drift between what the planner saw and what the client actually has does
// not crash the run.
//
// Dependency-free at runtime on purpose (only `import type`, which the Node
// test runner strips) so it can be unit-tested directly with
// `node --test --experimental-strip-types`.
// =====================================================================

import type {
  ComposeSourceRef,
  ComposeSourceSelection
} from "@/lib/types";

/** Minimal, structural view of a library source the resolver needs. Built
 *  from VideoSource + store state by the caller; kept tiny so tests don't
 *  have to construct Blobs/URLs. */
export interface ResolvableSource {
  id: string;
  /** Filename / title used for hint matching. */
  name: string;
  /** 0-based library position. */
  index: number;
  /** Ticked for AI use (selectedSourceIds). */
  selected: boolean;
  /** Currently in the preview pane (activeSourceId). */
  active: boolean;
  /** Optional per-source notes (acknowledge-mode chips) for semantic hints. */
  notes?: string[];
}

/** A selection paired with the source it resolved to (or null). */
export interface ResolvedSelection {
  selection: ComposeSourceSelection;
  source: ResolvableSource | null;
}

export interface ResolveResult {
  /** Selections that resolved to a concrete source, in input order. */
  resolved: Array<{ selection: ComposeSourceSelection; source: ResolvableSource }>;
  /** Selections that could not be resolved (surface to the user). */
  unresolved: ComposeSourceSelection[];
}

/** Normalise for case-insensitive substring hint matching. */
function norm(s: string): string {
  return (s || "").toLowerCase().trim();
}

/** Score how well `hint` matches a source's name/notes. Higher = better;
 *  0 = no match. Deterministic so resolution is stable. */
function hintScore(hint: string, src: ResolvableSource): number {
  const h = norm(hint);
  if (!h) return 0;
  const name = norm(src.name);
  let best = 0;
  if (name === h) best = Math.max(best, 100);
  if (name.includes(h)) best = Math.max(best, 60 + h.length);
  // Token overlap — any hint word appearing in the name or notes.
  const hayTokens = new Set(
    [name, ...(src.notes ?? []).map(norm)].join(" ").split(/[^a-z0-9]+/).filter(Boolean)
  );
  for (const token of h.split(/[^a-z0-9]+/).filter(Boolean)) {
    if (hayTokens.has(token)) best = Math.max(best, 30 + token.length);
  }
  return best;
}

/**
 * Resolve ONE source ref against the library. Returns null when nothing
 * sensible matches (the caller decides whether to ask the user).
 *
 * `used` lets the caller avoid handing the same source to two refs that
 * would otherwise both fall back to the same default (e.g. two bare
 * "selected" refs) — we skip already-used sources for the ambiguous
 * fallbacks (selected/active/hint) but NOT for explicit id/index, where the
 * user clearly named that exact source.
 */
export function resolveComposeSourceRef(
  ref: ComposeSourceRef,
  sources: ResolvableSource[],
  used: ReadonlySet<string> = new Set()
): ResolvableSource | null {
  if (!ref || sources.length === 0) return null;
  const free = (s: ResolvableSource | undefined): boolean =>
    !!s && !used.has(s.id);

  switch (ref.type) {
    case "id": {
      const byId = sources.find((s) => s.id === ref.sourceId);
      return byId ?? null;
    }
    case "index": {
      if (typeof ref.index !== "number" || !Number.isFinite(ref.index)) {
        return null;
      }
      const i = Math.trunc(ref.index);
      return i >= 0 && i < sources.length ? sources[i] : null;
    }
    case "active": {
      const active = sources.find((s) => s.active);
      if (active) return active;
      // Fall back to the first not-yet-used source so an "active" ref on a
      // restored session (no active flag) still resolves to something.
      return sources.find(free) ?? sources[0] ?? null;
    }
    case "selected": {
      const sel = sources.filter((s) => s.selected);
      const pickable = sel.find(free) ?? sel[0];
      if (pickable) return pickable;
      return sources.find(free) ?? sources[0] ?? null;
    }
    case "filename_hint":
    case "semantic_hint": {
      let best: ResolvableSource | null = null;
      let bestScore = 0;
      for (const s of sources) {
        const score = hintScore(ref.hint ?? "", s) + (free(s) ? 0.5 : 0);
        if (score > bestScore) {
          bestScore = score;
          best = s;
        }
      }
      return bestScore > 0 ? best : null;
    }
    default:
      return null;
  }
}

/**
 * Resolve every selection in order. Tracks already-used sources so the
 * ambiguous fallbacks don't collapse multiple refs onto one source, while
 * still allowing the SAME source to be referenced twice deliberately (by
 * explicit id/index) — e.g. "intro from the first video and the ending
 * from the first video too".
 */
export function resolveComposeSources(
  selections: ComposeSourceSelection[],
  sources: ResolvableSource[]
): ResolveResult {
  const resolved: ResolveResult["resolved"] = [];
  const unresolved: ComposeSourceSelection[] = [];
  const used = new Set<string>();

  for (const selection of selections) {
    const source = resolveComposeSourceRef(selection.sourceRef, sources, used);
    if (source) {
      resolved.push({ selection, source });
      // Only mark as "used" for fallback-dedupe when the ref was an
      // ambiguous kind. Explicit id/index references intentionally allow
      // reuse of the same source for multiple roles.
      if (
        selection.sourceRef.type === "active" ||
        selection.sourceRef.type === "selected" ||
        selection.sourceRef.type === "filename_hint" ||
        selection.sourceRef.type === "semantic_hint"
      ) {
        used.add(source.id);
      }
    } else {
      unresolved.push(selection);
    }
  }

  return { resolved, unresolved };
}

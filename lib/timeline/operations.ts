/**
 * Phase 3 — timeline operation engine.
 *
 * Pure transforms over a display-ordered `Highlight[]`. Each function
 * takes the current timeline + parameters and returns a NEW timeline plus
 * a small result descriptor (what changed, which clips were created, any
 * note for the user). Nothing here touches the store or React — the
 * client runner applies the returned array via the store's `setHighlights`
 * (which snapshots for one-step undo and, importantly, does NOT re-sort,
 * so explicit placement / move order is preserved).
 *
 * Rules honoured here (project goal):
 *   - "add" inserts; it never replaces the whole timeline.
 *   - An EXACT user range is kept verbatim — never dropped for overlap.
 *   - Operations are source-aware (each clip keeps its sourceId).
 *   - Undo is preserved (caller routes through setHighlights).
 */

import type { Highlight } from "@/lib/types";
import { appendToEnd, insertAt, moveClipTo, prependToStart } from "./placement";

let clipCounter = 0;
function newClipId(): string {
  clipCounter += 1;
  return `clip_${Date.now().toString(36)}_${clipCounter.toString(36)}`;
}

export interface NewClipInput {
  sourceId?: string;
  start: number;
  end: number;
  score?: number;
  reason: string;
  label?: string;
  confidence?: Highlight["confidence"];
  transition?: Highlight["transition"];
}

export interface TimelineOpResult {
  highlights: Highlight[];
  /** Number of clips added/removed/changed. */
  changed: number;
  /** Clip ids the op created (for selection + flow memory). */
  createdClipIds: string[];
  /** Optional one-line note for the user (e.g. a placement caveat). */
  note?: string;
}

function makeClip(input: NewClipInput): Highlight {
  return {
    id: newClipId(),
    start: round2(input.start),
    end: round2(input.end),
    score: input.score ?? 1,
    reason: input.reason,
    label: input.label,
    transition: input.transition ?? "fade",
    confidence: input.confidence ?? "high",
    sourceId: input.sourceId
  };
}

/** Re-stamp the first clip's transition to "none" (the render convention). */
function normalizeTransitions(list: Highlight[]): Highlight[] {
  return list.map((h, i) => (i === 0 ? { ...h, transition: "none" as const } : h));
}

// ---------------------------------------------------------------------
// Add operations
// ---------------------------------------------------------------------

/** Add one or more new clips (range or concept results) at a placement
 *  index (default: append to end). Exact ranges are inserted verbatim. */
export function addClips(
  current: Highlight[],
  inputs: NewClipInput[],
  index?: number
): TimelineOpResult {
  if (inputs.length === 0) return noChange(current);
  const created = inputs.map(makeClip);
  const at = index == null ? current.length : index;
  const next = normalizeTransitions(insertAt(current, created, at));
  return { highlights: next, changed: created.length, createdClipIds: created.map((c) => c.id) };
}

export function appendClips(current: Highlight[], inputs: NewClipInput[]): TimelineOpResult {
  if (inputs.length === 0) return noChange(current);
  const created = inputs.map(makeClip);
  return { highlights: normalizeTransitions(appendToEnd(current, created)), changed: created.length, createdClipIds: created.map((c) => c.id) };
}

export function prependClips(current: Highlight[], inputs: NewClipInput[]): TimelineOpResult {
  if (inputs.length === 0) return noChange(current);
  const created = inputs.map(makeClip);
  return { highlights: normalizeTransitions(prependToStart(current, created)), changed: created.length, createdClipIds: created.map((c) => c.id) };
}

/** Re-add an existing timeline clip (by id) at a new placement, as a
 *  copy. Used by "add clip 2 after clip 5". */
export function addClipRef(current: Highlight[], clipId: string, index: number): TimelineOpResult {
  const src = current.find((h) => h.id === clipId);
  if (!src) return noChange(current);
  const copy: Highlight = { ...src, id: newClipId() };
  const next = normalizeTransitions(insertAt(current, [copy], index));
  return { highlights: next, changed: 1, createdClipIds: [copy.id] };
}

// ---------------------------------------------------------------------
// Move / remove / replace
// ---------------------------------------------------------------------

export function moveClip(current: Highlight[], clipId: string, index: number): TimelineOpResult {
  if (!current.some((h) => h.id === clipId)) return noChange(current);
  const next = normalizeTransitions(moveClipTo(current, clipId, index));
  return { highlights: next, changed: 1, createdClipIds: [] };
}

export function removeClip(current: Highlight[], clipId: string): TimelineOpResult {
  const next = current.filter((h) => h.id !== clipId);
  if (next.length === current.length) return noChange(current);
  return { highlights: normalizeTransitions(next), changed: 1, createdClipIds: [] };
}

/** Replace a target clip with a new clip (range or concept result),
 *  keeping its timeline position. */
export function replaceClip(current: Highlight[], targetId: string, replacement: NewClipInput): TimelineOpResult {
  const idx = current.findIndex((h) => h.id === targetId);
  if (idx < 0) return noChange(current);
  const created = makeClip(replacement);
  const next = normalizeTransitions([...current.slice(0, idx), created, ...current.slice(idx + 1)]);
  return { highlights: next, changed: 1, createdClipIds: [created.id] };
}

// ---------------------------------------------------------------------
// Extend / trim a single clip
// ---------------------------------------------------------------------

export interface ExtendArgs {
  beforeSeconds?: number;
  afterSeconds?: number;
  /** Source duration so we don't extend past the end. */
  sourceDuration?: number;
}

export function extendClip(current: Highlight[], clipId: string, args: ExtendArgs): TimelineOpResult {
  const idx = current.findIndex((h) => h.id === clipId);
  if (idx < 0) return noChange(current);
  const c = current[idx];
  const start = Math.max(0, c.start - (args.beforeSeconds ?? 0));
  const end = Math.min(args.sourceDuration ?? Number.POSITIVE_INFINITY, c.end + (args.afterSeconds ?? 0));
  const updated: Highlight = { ...c, start: round2(start), end: round2(end) };
  const next = [...current.slice(0, idx), updated, ...current.slice(idx + 1)];
  return { highlights: next, changed: 1, createdClipIds: [] };
}

/** Trim a clip to an explicit [start, end] (clamped to its current span
 *  is NOT enforced — the user may widen via explicit times). */
export function trimClip(current: Highlight[], clipId: string, start?: number, end?: number): TimelineOpResult {
  const idx = current.findIndex((h) => h.id === clipId);
  if (idx < 0) return noChange(current);
  const c = current[idx];
  const ns = start != null ? round2(Math.max(0, start)) : c.start;
  const ne = end != null ? round2(end) : c.end;
  if (ne - ns < 0.1) return { ...noChange(current), note: "That trim would make the clip too short." };
  const updated: Highlight = { ...c, start: ns, end: ne };
  const next = [...current.slice(0, idx), updated, ...current.slice(idx + 1)];
  return { highlights: next, changed: 1, createdClipIds: [] };
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

function noChange(current: Highlight[]): TimelineOpResult {
  return { highlights: current, changed: 0, createdClipIds: [] };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

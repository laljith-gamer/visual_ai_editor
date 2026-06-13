// =====================================================================
// lib/plan/composeOrder.ts
//
// Pure ordering resolver for multi-source COMPOSE (montage) mode.
//
// Takes the per-source clips (each tagged with which source it came from,
// the user-mentioned order, a narrative role, its in-source start time and
// score) and arranges them into the final montage order. Default is
// source order — the order the user named the videos in.
//
// Dependency-free at runtime (only `import type`) so it can be unit-tested
// with `node --test --experimental-strip-types`.
// =====================================================================

import type { ComposeOrdering, ComposeRole } from "@/lib/types";

/** Structural shape the orderer needs. Callers attach this to whatever clip
 *  object they hold (e.g. a Highlight) and the orderer returns the same
 *  objects re-sequenced. */
export interface OrderableClip {
  /** 0-based index of the owning source in the resolved selection list. */
  sourceOrder: number;
  /** User-mentioned order ("first … then …"), if the planner supplied it. */
  userOrder?: number;
  role?: ComposeRole;
  /** Clip start within its source — chronological tie-break. */
  start: number;
  /** Composite match score — drives the energy_curve ordering. */
  score: number;
}

/** Seedable PRNG (mulberry32) so shuffles are deterministic in tests. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Narrative rank for story_arc ordering. Lower plays earlier. */
function roleRank(role: ComposeRole | undefined): number {
  switch (role) {
    case "intro":
      return 0;
    case "main":
    case "segment":
      return 1;
    case "middle":
    case "insert":
      return 2;
    case "ending":
      return 3;
    default:
      return 1;
  }
}

function bySourceThenStart<T extends OrderableClip>(a: T, b: T): number {
  if (a.sourceOrder !== b.sourceOrder) return a.sourceOrder - b.sourceOrder;
  return a.start - b.start;
}

/** Round-robin one clip from each source in source order. */
function interleave<T extends OrderableClip>(clips: T[]): T[] {
  const groups = new Map<number, T[]>();
  for (const c of [...clips].sort(bySourceThenStart)) {
    const list = groups.get(c.sourceOrder) ?? [];
    list.push(c);
    groups.set(c.sourceOrder, list);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => a - b).map(([, l]) => l);
  const out: T[] = [];
  let added = true;
  while (added) {
    added = false;
    for (const list of ordered) {
      const next = list.shift();
      if (next) {
        out.push(next);
        added = true;
      }
    }
  }
  return out;
}

/** Fisher–Yates shuffle using the supplied RNG (no in-place mutation). */
function shuffle<T>(clips: T[], rng: () => number): T[] {
  const out = [...clips];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Arrange ascending-by-score into a low→high→low "mountain". */
function energyCurve<T extends OrderableClip>(clips: T[]): T[] {
  const asc = [...clips].sort((a, b) => a.score - b.score);
  const n = asc.length;
  const res = new Array<T>(n);
  let lo = 0;
  let hi = n - 1;
  let i = 0;
  while (lo <= hi) {
    res[lo] = asc[i++];
    if (lo !== hi) res[hi] = asc[i++];
    lo++;
    hi--;
  }
  return res;
}

function orderCore<T extends OrderableClip>(
  clips: T[],
  type: ComposeOrdering["type"],
  rng: () => number
): T[] {
  switch (type) {
    case "user_mentioned_order":
      return [...clips].sort((a, b) => {
        const ao = a.userOrder ?? a.sourceOrder;
        const bo = b.userOrder ?? b.sourceOrder;
        if (ao !== bo) return ao - bo;
        return bySourceThenStart(a, b);
      });
    case "interleave":
      return interleave(clips);
    case "shuffle":
      return shuffle(clips, rng);
    case "story_arc":
      return [...clips].sort((a, b) => {
        const ra = roleRank(a.role);
        const rb = roleRank(b.role);
        if (ra !== rb) return ra - rb;
        return bySourceThenStart(a, b);
      });
    case "energy_curve":
      return energyCurve(clips);
    case "source_order":
    default:
      return [...clips].sort(bySourceThenStart);
  }
}

/**
 * Order the montage clips. When `anchorFirst` is set the single lead clip
 * (the first clip in plain source order) is pinned to the front and the
 * remaining clips get the requested ordering — this is "first video should
 * start first, then shuffle the rest".
 */
export function orderComposedClips<T extends OrderableClip>(
  clips: T[],
  ordering: ComposeOrdering,
  rng: () => number = Math.random
): T[] {
  if (clips.length <= 1) return [...clips];

  if (ordering.anchorFirst) {
    const sorted = [...clips].sort(bySourceThenStart);
    const lead = sorted[0];
    const rest = clips.filter((c) => c !== lead);
    return [lead, ...orderCore(rest, ordering.type, rng)];
  }

  return orderCore(clips, ordering.type, rng);
}

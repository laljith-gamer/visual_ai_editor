// =====================================================================
// lib/editor-memory/tree.ts
//
// INTERNAL tree-based memory for the video-editor AI. Not a UI, not a file
// the user edits — a hierarchical in-memory structure the agent reads before
// planning and writes after a confirmed edit. Persisted to IndexedDB by
// ./store.ts and injected into the planner by ./context.ts.
//
// Why a TREE (vs a flat list):
//   - natural SCOPING by path: user / project / source / session live on
//     separate branches and are retrieved/pruned independently;
//   - cheap subtree retrieval for prompt injection (only the relevant branch);
//   - promotion is just moving/copying a node up a branch
//     (session → project → user) as confidence/hits grow.
//
// Editing-specific examples (NOT coding):
//   ["user","format"]            = "vertical"     (cross-project default)
//   ["user","duration"]          = 30
//   ["user","pacing"]            = "fast"
//   ["project","rules","outro"]  = "brand-outro.mp4"  (explicit, high conf)
//   ["source", <hash>, "avoid"]  = ["intro","slow cutscenes"]
//   ["session","lastRequest"]    = "combine best fights, 30s"
//
// PURE: no I/O, no React, no Date.now() except via an injected `now`. Fully
// unit-tested.
// =====================================================================

export type MemoryValue = string | number | boolean | string[];

export interface MemoryNode {
  /** Leaf payload. Absent on pure branch nodes. */
  value?: MemoryValue;
  /** 0..1 belief in this memory. Instructions are written at 1. */
  confidence?: number;
  /** One-line, human-readable justification ("user chose vertical 3x"). */
  evidence?: string;
  /** ms epoch of the last write. */
  updatedAt?: number;
  /** Times this leaf was reinforced — drives promotion + decay. */
  hits?: number;
  /** Child branches, keyed by path segment. */
  children?: Record<string, MemoryNode>;
}

export interface MemoryTree {
  version: number;
  root: MemoryNode;
}

export const MEMORY_TREE_VERSION = 1;

export function createTree(): MemoryTree {
  return { version: MEMORY_TREE_VERSION, root: {} };
}

// ---------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------

/** Return the node at `path`, or null if any segment is missing. */
export function getNode(tree: MemoryTree, path: string[]): MemoryNode | null {
  let node: MemoryNode | undefined = tree.root;
  for (const seg of path) {
    node = node?.children?.[seg];
    if (!node) return null;
  }
  return node ?? null;
}

/** Convenience: the leaf VALUE at `path` (or null). */
export function getValue(tree: MemoryTree, path: string[]): MemoryValue | null {
  return getNode(tree, path)?.value ?? null;
}

// ---------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------

export interface SetOptions {
  confidence?: number;
  evidence?: string;
  /** Injected clock so the module stays pure/testable. Defaults to Date.now. */
  now?: number;
}

/**
 * Set (or overwrite) a leaf value at `path`, creating intermediate branches.
 * Resets hits to 1 (a fresh assertion). Use `reinforce` to strengthen an
 * existing belief instead of replacing it.
 */
export function setMemory(
  tree: MemoryTree,
  path: string[],
  value: MemoryValue,
  opts: SetOptions = {}
): MemoryTree {
  if (path.length === 0) return tree;
  const now = opts.now ?? Date.now();
  const node = ensureBranch(tree.root, path);
  node.value = value;
  node.confidence = clamp01(opts.confidence ?? node.confidence ?? 0.6);
  if (opts.evidence !== undefined) node.evidence = opts.evidence;
  node.updatedAt = now;
  node.hits = node.hits ?? 1;
  return tree;
}

/**
 * Reinforce a belief at `path`. If the value matches, bump hits + confidence
 * (the memory gets stronger the more often the user does it). If it differs,
 * the newer value wins but starts a fresh streak (preferences can change).
 */
export function reinforce(
  tree: MemoryTree,
  path: string[],
  value: MemoryValue,
  opts: SetOptions = {}
): MemoryTree {
  if (path.length === 0) return tree;
  const now = opts.now ?? Date.now();
  const node = ensureBranch(tree.root, path);
  const same = node.value !== undefined && valuesEqual(node.value, value);
  node.value = value;
  node.hits = same ? (node.hits ?? 0) + 1 : 1;
  // Confidence rises with repetition (diminishing), capped below 1 so an
  // explicit instruction (set at 1) always outranks a learned habit.
  const base = same ? node.confidence ?? 0.5 : 0.5;
  node.confidence = clamp01(Math.min(0.95, base + 0.15 * Math.min(node.hits, 4)));
  if (opts.confidence !== undefined) node.confidence = clamp01(opts.confidence);
  if (opts.evidence !== undefined) node.evidence = opts.evidence;
  node.updatedAt = now;
  return tree;
}

/** Delete the node at `path` (and prune now-empty parent branches). */
export function forget(tree: MemoryTree, path: string[]): MemoryTree {
  if (path.length === 0) {
    tree.root = {};
    return tree;
  }
  removeAtPath(tree.root, path);
  return tree;
}

// ---------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------

export interface PruneOptions {
  /** Drop leaves below this confidence. Default 0.3. */
  minConfidence?: number;
  /** Drop leaves older than this many ms. Default: no age limit. */
  maxAgeMs?: number;
  now?: number;
}

/**
 * Remove weak/stale leaves and any branch left empty. Keeps the tree small so
 * prompt injection stays cheap and the model isn't fed dead context.
 */
export function pruneTree(tree: MemoryTree, opts: PruneOptions = {}): MemoryTree {
  const minConfidence = opts.minConfidence ?? 0.3;
  const now = opts.now ?? Date.now();
  pruneNode(tree.root, minConfidence, opts.maxAgeMs, now);
  return tree;
}

// ---------------------------------------------------------------------
// Promotion (session → project → user)
// ---------------------------------------------------------------------

/**
 * Copy a leaf from one path to another when it's earned promotion (enough
 * hits + confidence) — e.g. a per-session pacing choice that recurs becomes a
 * cross-project user preference. Never overwrites a higher-confidence target
 * (so an explicit instruction at the destination wins). Returns true if it
 * promoted.
 */
export function promote(
  tree: MemoryTree,
  from: string[],
  to: string[],
  opts: { minHits?: number; minConfidence?: number; now?: number } = {}
): boolean {
  const src = getNode(tree, from);
  if (!src || src.value === undefined) return false;
  if ((src.hits ?? 0) < (opts.minHits ?? 3)) return false;
  if ((src.confidence ?? 0) < (opts.minConfidence ?? 0.8)) return false;

  const dst = getNode(tree, to);
  if (dst && (dst.confidence ?? 0) > (src.confidence ?? 0)) return false;

  setMemory(tree, to, src.value, {
    confidence: src.confidence,
    evidence: src.evidence ?? "promoted from repeated use",
    now: opts.now
  });
  const promoted = getNode(tree, to);
  if (promoted) promoted.hits = src.hits;
  return true;
}

// ---------------------------------------------------------------------
// Context serialization (for prompt injection)
// ---------------------------------------------------------------------

export interface FlatMemory {
  path: string[];
  value: MemoryValue;
  confidence: number;
  evidence?: string;
}

/**
 * Flatten the leaves under `path` (default: whole tree) into a compact list,
 * strongest first, filtered by confidence. ./context.ts turns these into the
 * short "what I know about this creator/footage" block fed to the planner.
 */
export function flatten(
  tree: MemoryTree,
  path: string[] = [],
  opts: { minConfidence?: number } = {}
): FlatMemory[] {
  const root = path.length === 0 ? tree.root : getNode(tree, path);
  if (!root) return [];
  const min = opts.minConfidence ?? 0.5;
  const out: FlatMemory[] = [];
  walk(root, [...path], out, min);
  return out.sort((a, b) => b.confidence - a.confidence);
}

export function serialize(tree: MemoryTree): string {
  return JSON.stringify(tree);
}

export function deserialize(raw: string | null | undefined): MemoryTree {
  if (!raw) return createTree();
  try {
    const parsed = JSON.parse(raw) as MemoryTree;
    if (!parsed || typeof parsed !== "object" || !parsed.root) return createTree();
    return { version: parsed.version ?? MEMORY_TREE_VERSION, root: parsed.root };
  } catch {
    return createTree();
  }
}

// ---------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------

function ensureBranch(root: MemoryNode, path: string[]): MemoryNode {
  let node = root;
  for (const seg of path) {
    node.children = node.children ?? {};
    node.children[seg] = node.children[seg] ?? {};
    node = node.children[seg];
  }
  return node;
}

function removeAtPath(root: MemoryNode, path: string[]): void {
  const parents: MemoryNode[] = [];
  let node: MemoryNode | undefined = root;
  for (let i = 0; i < path.length - 1; i++) {
    parents.push(node!);
    node = node!.children?.[path[i]];
    if (!node) return;
  }
  const lastKey = path[path.length - 1];
  if (node?.children) delete node.children[lastKey];
  // Walk back up dropping empty branches.
  let idx = parents.length - 1;
  let cursor = node;
  for (let i = idx; i >= 0; i--) {
    if (cursor && isEmptyBranch(cursor)) {
      const parent = parents[i];
      const key = path[i];
      if (parent.children) delete parent.children[key];
      cursor = parent;
    } else {
      break;
    }
  }
}

function isEmptyBranch(node: MemoryNode): boolean {
  const hasChildren = node.children && Object.keys(node.children).length > 0;
  return node.value === undefined && !hasChildren;
}

function pruneNode(
  node: MemoryNode,
  minConfidence: number,
  maxAgeMs: number | undefined,
  now: number
): void {
  if (!node.children) return;
  for (const key of Object.keys(node.children)) {
    const child = node.children[key];
    pruneNode(child, minConfidence, maxAgeMs, now);
    const isLeaf = child.value !== undefined;
    const weak = isLeaf && (child.confidence ?? 0) < minConfidence;
    const stale =
      isLeaf &&
      maxAgeMs !== undefined &&
      typeof child.updatedAt === "number" &&
      now - child.updatedAt > maxAgeMs;
    const emptyAfter =
      !child.children || Object.keys(child.children).length === 0;
    if ((weak || stale) && emptyAfter) {
      delete node.children[key];
    } else if (child.value === undefined && emptyAfter) {
      delete node.children[key];
    }
  }
}

function walk(
  node: MemoryNode,
  path: string[],
  out: FlatMemory[],
  min: number
): void {
  if (node.value !== undefined && (node.confidence ?? 0) >= min) {
    out.push({
      path,
      value: node.value,
      confidence: node.confidence ?? 0,
      ...(node.evidence ? { evidence: node.evidence } : {})
    });
  }
  if (node.children) {
    for (const key of Object.keys(node.children)) {
      walk(node.children[key], [...path, key], out, min);
    }
  }
}

function valuesEqual(a: MemoryValue, b: MemoryValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }
  return a === b;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

// =====================================================================
// lib/store/projectRestore.ts
//
// PURE project-history restore logic. No React, no zustand, no browser
// APIs (it never creates an object URL or touches IndexedDB). The store
// (hooks/useEditorStore.ts) is a thin wrapper that calls these helpers and
// only does the impure parts: URL.createObjectURL / revokeObjectURL and
// set(). Keeping the decisions here makes the whole restore/hydrate/render-
// guard flow unit-testable with `node --test`.
//
// CORE IDEA
// ---------
// We do NOT persist video blobs. Instead each project remembers a
// `PersistedSourceManifest[]` (hash + metadata + last filename). On restore
// the sources become `RestoredSourcePlaceholder`s (missing: true) that keep
// the SAME ids, so the timeline still references them. When the user
// re-uploads a file we match by HASH (never filename) and reconnect it to
// the original id — the timeline becomes renderable again automatically.
// =====================================================================

import type {
  BestPart,
  Highlight,
  PersistedSourceManifest,
  RestoredSourcePlaceholder,
  Session,
  VideoSource,
  VideoSourceMeta
} from "../types";

// ---------------------------------------------------------------------
// Manifest <-> runtime conversions
// ---------------------------------------------------------------------

/** Build the persisted manifest for a hydrated runtime source. */
export function manifestFromSource(
  source: Pick<VideoSource, "id" | "hash" | "meta" | "addedAt">
): PersistedSourceManifest {
  return {
    id: source.id,
    hash: source.hash,
    meta: source.meta,
    addedAt: source.addedAt,
    lastKnownName: source.meta.name,
    status: "available"
  };
}

/** Build the persisted manifest for a still-missing placeholder. */
export function manifestFromPlaceholder(
  ph: RestoredSourcePlaceholder
): PersistedSourceManifest {
  return {
    id: ph.id,
    hash: ph.hash,
    meta: ph.meta,
    addedAt: ph.addedAt,
    lastKnownName: ph.meta.name,
    status: "missing"
  };
}

/** Turn a manifest into a missing placeholder (no blob, no URL). */
export function placeholderFromManifest(
  m: PersistedSourceManifest
): RestoredSourcePlaceholder {
  return {
    id: m.id,
    hash: m.hash,
    meta: m.meta,
    addedAt: m.addedAt,
    missing: true
  };
}

// ---------------------------------------------------------------------
// Migration: any Session (v1 / v1.6 / v2) -> manifests
// ---------------------------------------------------------------------

/** Deterministic id for a migrated legacy single-video session. Stable for
 *  a given hash so re-uploads + highlight backfill always line up. */
export function legacySourceId(session: Pick<Session, "videoHash">): string {
  const h = session.videoHash ? session.videoHash.slice(0, 12) : "unknown";
  return `src_legacy_${h}`;
}

/**
 * Migrate ANY persisted session into a source manifest list.
 *
 *  - v2  (`sourceManifests`)            → used as-is.
 *  - v1.6 (`sources: VideoSourceSummary[]`) → mapped to manifests.
 *  - v1  (`videoMeta` + `videoHash`)    → a single manifest (id derived
 *                                         from activeSourceId or the hash).
 *  - empty                              → [].
 */
export function migrateSessionToManifests(
  session: Session
): PersistedSourceManifest[] {
  if (Array.isArray(session.sourceManifests) && session.sourceManifests.length > 0) {
    return session.sourceManifests.map((m) => ({
      ...m,
      lastKnownName: m.lastKnownName ?? m.meta.name,
      // Preserve the save-time availability so the history summary can
      // report how many sources were already missing. The RESTORE path
      // (buildRestoredProjectState) turns ALL of these into placeholders
      // regardless — blobs are never persisted, so nothing is loaded yet.
      status: m.status ?? "missing"
    }));
  }

  if (Array.isArray(session.sources) && session.sources.length > 0) {
    return session.sources.map((s) => ({
      id: s.id,
      hash: s.hash,
      meta: s.meta,
      addedAt: s.addedAt,
      lastKnownName: s.meta.name,
      status: "missing"
    }));
  }

  if (session.videoMeta && session.videoHash) {
    const meta: VideoSourceMeta = {
      name: session.videoMeta.name,
      size: session.videoMeta.size,
      duration: session.videoMeta.duration,
      width: session.videoMeta.width,
      height: session.videoMeta.height
    };
    return [
      {
        id: session.activeSourceId ?? legacySourceId(session),
        hash: session.videoHash,
        meta,
        addedAt: session.createdAt ?? Date.now(),
        lastKnownName: meta.name,
        status: "missing"
      }
    ];
  }

  return [];
}

/**
 * Backfill missing `sourceId`s on legacy highlights. v1 single-video
 * sessions stored highlights WITHOUT a sourceId; once we know the single
 * manifest id we stamp it so the timeline can reconnect on re-upload.
 * Multi-source sessions (every highlight already tagged, or >1 manifest)
 * are returned unchanged.
 */
export function backfillHighlightSources(
  highlights: Highlight[],
  manifests: PersistedSourceManifest[]
): Highlight[] {
  if (manifests.length !== 1) return highlights;
  const onlyId = manifests[0].id;
  let changed = false;
  const out = highlights.map((h) => {
    if (h.sourceId) return h;
    changed = true;
    return { ...h, sourceId: onlyId };
  });
  return changed ? out : highlights;
}

// ---------------------------------------------------------------------
// Restore payload (no blobs)
// ---------------------------------------------------------------------

export interface RestoredProjectState {
  manifests: PersistedSourceManifest[];
  missingSources: RestoredSourcePlaceholder[];
  highlights: Highlight[];
  selectedClipId: string | null;
  activeSourceId: string | null;
  selectedSourceIds: string[];
}

/**
 * Compute the blob-free portion of a session restore: manifests →
 * placeholders, highlight backfill, and the active/selected ids. The store
 * merges this with the rest of the snapshot (plan, messages, memory, …) and
 * does the URL housekeeping. Crucially the placeholders here NEVER have a
 * blob or url — restoring a missing source must not allocate an object URL.
 */
export function buildRestoredProjectState(session: Session): RestoredProjectState {
  const manifests = migrateSessionToManifests(session);
  const missingSources = manifests.map(placeholderFromManifest);
  const highlights = backfillHighlightSources(session.highlights ?? [], manifests);

  // Active id: prefer the saved one; else the only source (single-video);
  // else null. We keep it even though the source is missing — when the same
  // id hydrates, the preview reconnects automatically.
  const activeSourceId =
    session.activeSourceId ??
    (manifests.length === 1 ? manifests[0].id : null);

  // Selected ids: prefer saved; else the single source; filtered to known
  // manifest ids so we never carry a dangling selection.
  const knownIds = new Set(manifests.map((m) => m.id));
  let selectedSourceIds = (session.selectedSourceIds ?? []).filter((id) =>
    knownIds.has(id)
  );
  if (selectedSourceIds.length === 0 && manifests.length === 1) {
    selectedSourceIds = [manifests[0].id];
  }

  const selectedClipId =
    session.selectedClipId !== undefined
      ? session.selectedClipId
      : highlights[0]?.id ?? null;

  return {
    manifests,
    missingSources,
    highlights,
    selectedClipId:
      selectedClipId && highlights.some((h) => h.id === selectedClipId)
        ? selectedClipId
        : highlights[0]?.id ?? null,
    activeSourceId,
    selectedSourceIds
  };
}

// ---------------------------------------------------------------------
// Upload identity: hash-match a re-upload to a missing placeholder
// ---------------------------------------------------------------------

export type UploadIdentity =
  | { kind: "hydrate"; placeholder: RestoredSourcePlaceholder }
  | { kind: "new" };

/**
 * Decide what a freshly-probed upload IS, by hash only.
 *   - matches a missing placeholder's hash → reconnect (hydrate that id).
 *   - otherwise                            → a brand-new source.
 *
 * Filename/size are deliberately ignored — the hash is the sole identity
 * key (a renamed copy of the same file must still reconnect; two different
 * files with the same name must NOT).
 */
export function resolveUploadIdentity(
  missing: RestoredSourcePlaceholder[],
  hash: string
): UploadIdentity {
  const placeholder = missing.find((p) => p.hash === hash);
  return placeholder ? { kind: "hydrate", placeholder } : { kind: "new" };
}

// ---------------------------------------------------------------------
// Render guard: which sources used by the timeline are still missing
// ---------------------------------------------------------------------

/** The set of source ids the timeline actually references. A highlight with
 *  no explicit sourceId is resolved against `fallbackId` (the active/only
 *  source) when one is given. */
export function usedSourceIds(
  highlights: Highlight[],
  fallbackId?: string | null
): Set<string> {
  const ids = new Set<string>();
  for (const h of highlights) {
    const id = h.sourceId ?? fallbackId ?? null;
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * The missing placeholders that the CURRENT timeline depends on — i.e. the
 * videos the user must re-upload before this project can render. Matches by
 * explicit sourceId; an untagged highlight only counts when there are no
 * hydrated sources at all and exactly one missing placeholder (the legacy
 * single-video case before backfill).
 */
export function usedMissingSources(
  highlights: Highlight[],
  missing: RestoredSourcePlaceholder[],
  hydratedIds: Set<string>
): RestoredSourcePlaceholder[] {
  const referenced = usedSourceIds(highlights);
  const out = missing.filter((p) => referenced.has(p.id));
  if (
    out.length === 0 &&
    hydratedIds.size === 0 &&
    missing.length === 1 &&
    highlights.some((h) => !h.sourceId)
  ) {
    return [missing[0]];
  }
  return out;
}

/**
 * Can the current timeline be rendered RIGHT NOW? False when it is empty or
 * when any clip references a source whose bytes aren't loaded. This is the
 * render guard — it must be true before ffmpeg/mediabunny is invoked so we
 * never crash on a missing input.
 */
export function canRenderTimeline(
  highlights: Highlight[],
  hydratedIds: Set<string>
): boolean {
  if (highlights.length === 0) return false;
  for (const h of highlights) {
    if (h.sourceId) {
      if (!hydratedIds.has(h.sourceId)) return false;
    } else if (hydratedIds.size === 0) {
      // An untagged legacy clip needs at least one loaded source to play.
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------
// History summary (Phase 3)
// ---------------------------------------------------------------------

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  sourceCount: number;
  /** Sources that were ALREADY missing (a placeholder, no blob) at save
   *  time — i.e. the project was saved while partially un-restored. */
  saveTimeMissingCount: number;
  /** Sources the user must re-upload after a FRESH load. Because we never
   *  persist blobs by default, this equals `sourceCount` whenever there are
   *  any sources — every source needs re-providing on the next open. (A
   *  future blob / File System Access persistence feature would lower it.) */
  restoreNeededCount: number;
  clipCount: number;
  totalDurationSeconds: number;
  format?: string;
  status: Session["status"];
  /** Last user request, else the plan rationale, else undefined. */
  lastAction?: string;
}

/** Build a project-level summary for the history list. Pure. */
export function summarizeSession(session: Session): SessionSummary {
  const manifests = migrateSessionToManifests(session);
  const sourceCount = manifests.length;
  const saveTimeMissingCount = manifests.filter((m) => m.status === "missing").length;
  // No blobs are persisted, so on a fresh load EVERY source needs a
  // re-upload. Don't pretend "0 missing" just because they were
  // "available" at save time.
  const restoreNeededCount = sourceCount;
  const highlights = session.highlights ?? [];
  const totalDurationSeconds = highlights.reduce(
    (acc, h) => acc + Math.max(0, h.end - h.start),
    0
  );

  let lastAction: string | undefined;
  for (let i = (session.messages ?? []).length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m.role === "user" && m.content.trim()) {
      lastAction = m.content.trim();
      break;
    }
  }
  if (!lastAction && session.plan?.rationale) {
    lastAction = session.plan.rationale;
  }

  return {
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt,
    sourceCount,
    saveTimeMissingCount,
    restoreNeededCount,
    clipCount: highlights.length,
    totalDurationSeconds,
    format: session.plan?.format,
    status: session.status,
    lastAction
  };
}

// ---------------------------------------------------------------------
// Persist payload: build manifests from live state (hydrated + missing)
// ---------------------------------------------------------------------

/** Combine hydrated runtime sources + still-missing placeholders into the
 *  manifest list to persist. Hydrated sources are "available"; placeholders
 *  stay "missing". Order: hydrated first (their original order), then any
 *  not-yet-rehydrated placeholders, so nothing is lost across a save of a
 *  partially-restored project. */
export function buildPersistManifests(
  sources: Array<Pick<VideoSource, "id" | "hash" | "meta" | "addedAt">>,
  missing: RestoredSourcePlaceholder[]
): PersistedSourceManifest[] {
  const seen = new Set<string>();
  const out: PersistedSourceManifest[] = [];
  for (const s of sources) {
    out.push(manifestFromSource(s));
    seen.add(s.id);
  }
  for (const p of missing) {
    if (seen.has(p.id)) continue;
    out.push(manifestFromPlaceholder(p));
    seen.add(p.id);
  }
  return out;
}

/** Whether a restored lastBriefing is still safe to keep — its source must
 *  still be a known manifest id. */
export function briefingStillValid(
  lastBriefing: { sourceId: string; bestParts: BestPart[] } | null | undefined,
  manifests: PersistedSourceManifest[]
): boolean {
  if (!lastBriefing) return false;
  return manifests.some((m) => m.id === lastBriefing.sourceId);
}

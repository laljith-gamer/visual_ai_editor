// =====================================================================
// lib/store/idb.ts
//
// Self-healing IndexedDB layer (idb-keyval).
//
// THE BUG THIS GUARDS AGAINST
// ---------------------------
// idb-keyval's createStore(dbName, storeName) opens the DB WITHOUT a
// version and only creates `storeName` in the one-shot `onupgradeneeded`.
// If a DB with that name already exists but does NOT contain the expected
// object store (stale dev data, a failed upgrade, an old build, or two
// createStore calls sharing one dbName with different storeNames), the open
// SUCCEEDS but the first `transaction(storeName)` throws:
//
//   NotFoundError: Failed to execute 'transaction' on 'IDBDatabase':
//   One of the specified object stores was not found.
//
// That used to bubble up as a red crash bubble. Now every read/write goes
// through `withIdbRecovery`: on a missing-object-store error we drop the
// cached (broken) store reference, delete ONLY that one database, recreate
// the store, and retry the operation exactly once.
//
// PRIVACY: recovery only ever console.warn's the DB name + operation name.
// It NEVER logs stored values (sessions, predictions, logs, transcripts),
// video bytes, base64 frames, prompts, API keys, or transcript text.
// =====================================================================

import {
  get,
  set,
  del,
  keys,
  update,
  createStore,
  type UseStore
} from "idb-keyval";

/** Logical stores. Each maps to its OWN database (one object store per DB)
 *  so they can be deleted/recovered independently and never collide. */
export type IdbKind = "sessions" | "cache" | "logs" | "transcripts";

interface DbSpec {
  dbName: string;
  storeName: string;
}

// NOTE: every DB uses a UNIQUE dbName. Transcripts intentionally live in
// their own database ("shorts-studio-transcripts") rather than sharing
// "shorts-studio-cache" — sharing one dbName across two object stores is
// exactly what triggers the "object store not found" crash with idb-keyval.
const DB_SPECS: Record<IdbKind, DbSpec> = {
  sessions: { dbName: "shorts-studio-sessions", storeName: "kv" },
  cache: { dbName: "shorts-studio-cache", storeName: "kv" },
  logs: { dbName: "shorts-studio-logs", storeName: "kv" },
  transcripts: { dbName: "shorts-studio-transcripts", storeName: "kv" }
};

/** All database names this app owns (for the emergency reset util). */
export const IDB_DATABASE_NAMES: string[] = Object.values(DB_SPECS).map(
  (s) => s.dbName
);

// Lazily-created stores. Cleared on recovery so a fresh createStore() runs
// AFTER deleteDatabase() — idb-keyval caches its DB-open promise inside the
// returned UseStore, so the broken handle must be thrown away, not reused.
const stores: Partial<Record<IdbKind, UseStore>> = {};

function getStore(kind: IdbKind): UseStore {
  let store = stores[kind];
  if (!store) {
    const spec = DB_SPECS[kind];
    store = createStore(spec.dbName, spec.storeName);
    stores[kind] = store;
  }
  return store;
}

/**
 * True when an error indicates the requested object store doesn't exist in
 * the opened database (the recoverable corruption case). Matches the
 * NotFoundError name and the various message phrasings browsers use.
 */
export function isMissingObjectStoreError(error: unknown): boolean {
  if (!error) return false;
  const name =
    typeof error === "object" && error !== null
      ? (error as { name?: string }).name
      : undefined;
  if (name === "NotFoundError") return true;

  const message =
    typeof error === "object" && error !== null
      ? String((error as { message?: string }).message ?? "")
      : String(error);
  const m = message.toLowerCase();
  return (
    (m.includes("object store") && m.includes("not found")) ||
    m.includes("specified object stores was not found") ||
    m.includes("one of the specified object stores was not found")
  );
}

/** Clean, user-facing message shown when local storage is corrupted beyond
 *  the one-shot auto-recovery (e.g. a delete stayed blocked). Never expose
 *  the raw IndexedDB exception text as the primary app error. */
export const STORAGE_CORRUPTED_MESSAGE =
  "Local browser storage was corrupted. Please clear site data and reload.";

/**
 * Map a caught error to a friendly storage message, or null if it isn't a
 * storage-corruption error (so callers keep their own message). Use at UI
 * error sites: `const msg = friendlyStorageError(err) ?? (err as Error).message;`
 */
export function friendlyStorageError(error: unknown): string | null {
  return isMissingObjectStoreError(error) ? STORAGE_CORRUPTED_MESSAGE : null;
}

/**
 * Delete a single database, best-effort. Resolves on success, error, OR
 * blocked (an open connection elsewhere) so recovery never hangs. We never
 * throw from here — a failed delete just means the retry may not succeed and
 * the caller surfaces the clean fallback message.
 */
export async function deleteDatabaseSafe(dbName: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = finish;
      request.onerror = finish;
      // If another connection is still open the delete is `blocked`. We do
      // NOT resolve here — we wait for the eventual `onsuccess` (which fires
      // once that connection closes) so the one-shot retry sees a truly
      // deleted DB rather than racing a not-yet-deleted one. The timeout
      // below is the safety net so recovery can never hang.
      request.onblocked = () => {};
      setTimeout(finish, 2000);
    } catch {
      finish();
    }
  });
}

/**
 * Run an idb-keyval operation with one-shot recovery from missing-object-
 * store corruption. On that specific error: drop the cached store, delete
 * ONLY this kind's database, recreate the store, and retry once. Any other
 * error propagates unchanged.
 */
export async function withIdbRecovery<T>(
  kind: IdbKind,
  operationName: string,
  operation: (store: UseStore) => Promise<T>
): Promise<T> {
  try {
    return await operation(getStore(kind));
  } catch (error) {
    if (!isMissingObjectStoreError(error)) throw error;

    const spec = DB_SPECS[kind];
    // Throw away the broken handle BEFORE deleting so the next getStore()
    // builds a fresh connection against the recreated DB.
    delete stores[kind];
    await deleteDatabaseSafe(spec.dbName);
    // Recovery is safe to surface in the console — name + op only, no values.
    // eslint-disable-next-line no-console
    console.warn(
      `Recovered IndexedDB store: ${spec.dbName} during ${operationName}`
    );
    // Retry exactly once against a freshly-created store.
    return await operation(getStore(kind));
  }
}

// ---------------------------------------------------------------------
// Safe primitives — use these (or the idbSessions/idbCache/idbLog wrappers
// below) instead of calling idb-keyval directly.
// ---------------------------------------------------------------------

export function safeGet<T>(kind: IdbKind, key: IDBValidKey): Promise<T | undefined> {
  return withIdbRecovery(kind, "get", (store) => get<T>(key, store));
}

export function safeSet<T>(kind: IdbKind, key: IDBValidKey, value: T): Promise<void> {
  return withIdbRecovery(kind, "set", (store) => set(key, value, store));
}

export function safeDel(kind: IdbKind, key: IDBValidKey): Promise<void> {
  return withIdbRecovery(kind, "del", (store) => del(key, store));
}

export function safeKeys<KeyType extends IDBValidKey = IDBValidKey>(
  kind: IdbKind
): Promise<KeyType[]> {
  return withIdbRecovery(kind, "keys", (store) => keys<KeyType>(store));
}

export function safeUpdate<T>(
  kind: IdbKind,
  key: IDBValidKey,
  updater: (oldValue: T | undefined) => T
): Promise<void> {
  return withIdbRecovery(kind, "update", (store) => update<T>(key, updater, store));
}

/**
 * EMERGENCY developer utility — delete every app database and let them be
 * recreated lazily on next use. Exposed for support/debugging; NOT wired to
 * any destructive UI button. Equivalent console snippet:
 *
 *   indexedDB.deleteDatabase("shorts-studio-sessions");
 *   indexedDB.deleteDatabase("shorts-studio-cache");
 *   indexedDB.deleteDatabase("shorts-studio-logs");
 *   indexedDB.deleteDatabase("shorts-studio-transcripts");
 *   location.reload();
 */
export async function resetAllLocalDatabases(): Promise<void> {
  for (const kind of Object.keys(stores) as IdbKind[]) delete stores[kind];
  await Promise.all(IDB_DATABASE_NAMES.map((name) => deleteDatabaseSafe(name)));
}

// ---------------------------------------------------------------------
// Stable public API (unchanged shape — now self-healing under the hood, so
// sessions.ts / cache.ts / log/store.ts need no changes).
// ---------------------------------------------------------------------

export const idbSessions = {
  get: <T>(key: string) => safeGet<T>("sessions", key),
  set: <T>(key: string, value: T) => safeSet<T>("sessions", key, value),
  del: (key: string) => safeDel("sessions", key),
  keys: () => safeKeys("sessions")
};

export const idbCache = {
  get: <T>(key: string) => safeGet<T>("cache", key),
  set: <T>(key: string, value: T) => safeSet<T>("cache", key, value),
  del: (key: string) => safeDel("cache", key),
  keys: () => safeKeys("cache")
};

export const idbLog = {
  get: <T>(key: string) => safeGet<T>("logs", key),
  set: <T>(key: string, value: T) => safeSet<T>("logs", key, value),
  del: (key: string) => safeDel("logs", key),
  keys: () => safeKeys("logs")
};

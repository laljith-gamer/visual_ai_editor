/**
 * Module-scoped, in-memory handoff for the user-picked video file
 * between the home page (/) and the loading transition (/launch).
 *
 * We can't put a `File` in sessionStorage or in the URL, and we don't
 * want to add it to the persisted Zustand store (it'd serialise on
 * every navigation). Next.js client-side navigation keeps this module
 * loaded across route transitions, so a plain module-level variable
 * is the simplest correct primitive.
 *
 * Lifecycle:
 *   1. Home page validates the user's File and calls `setPendingUpload`.
 *   2. Home page navigates to /launch.
 *   3. Launch page calls `consumePendingUpload` on mount; if it gets
 *      back null, it bounces home (direct navigation guard).
 *   4. Launch runs probe + hash + addSource, animates progress, then
 *      replaces history with /editor.
 *
 * The handoff is single-use — `consume` clears the slot so a refresh
 * on /launch can't accidentally re-process a stale file.
 */
let pending: File | null = null;

export function setPendingUpload(file: File): void {
  pending = file;
}

export function consumePendingUpload(): File | null {
  const f = pending;
  pending = null;
  return f;
}

export function peekPendingUpload(): File | null {
  return pending;
}

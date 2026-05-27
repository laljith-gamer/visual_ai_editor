"use client";

import type { ActivityEvent } from "@/lib/types";
import { ACTIVITY } from "@/lib/config";
import { activityLogStore } from "./store";

/**
 * Render a compact, planner-friendly summary of recent activity.
 *
 * Output is line-based, one event per line, ordered oldest → newest:
 *
 *   Recent activity (last 12, oldest first):
 *   - [3m ago] USER moved clip 2: 43.5s → 41.2s (−2.3s)
 *   - [2m ago] USER said "make it punchier"
 *   - [1m ago] AI temporal verdict: keepScore=0.81 ("goal celebration")
 *
 * The planner is told (in lib/plan/prompt.ts) how to read these signals
 * to bias the next plan or refinement.
 */
export function summarizeRecentActivity(): string {
  const all = activityLogStore.getSnapshot();
  if (all.length === 0) return "";
  const now = Date.now();
  const fresh = all.filter((e) => now - e.ts <= ACTIVITY.recentMaxAgeMs);
  if (fresh.length === 0) return "";

  // Cap noisy actors so 50 micro-edits don't drown out the chat history.
  const trimmed = trimNoisyEvents(fresh, ACTIVITY.noisyEventCap);
  const recent = trimmed.slice(-ACTIVITY.recentForPlanner);

  const lines: string[] = [];
  lines.push(`Recent activity (last ${recent.length}, oldest first):`);
  for (const e of recent) {
    lines.push(`- [${formatAgo(now - e.ts)}] ${e.actor.toUpperCase()}: ${describeEvent(e)}`);
  }
  return lines.join("\n");
}

/** Single-line render of an event for the planner prompt or the drawer. */
export function describeEvent(e: ActivityEvent): string {
  if (e.summary && e.summary.trim()) {
    return e.summary + (e.count && e.count > 1 ? ` (×${e.count})` : "");
  }
  // Best-effort fallback: render kind + a tiny payload preview.
  const preview = compactPayload(e.payload);
  const base = preview ? `${e.kind} (${preview})` : e.kind;
  return e.count && e.count > 1 ? `${base} (×${e.count})` : base;
}

/** Drop or merge noisy bursts (e.g., 30 clip-resize releases in a row) so
 *  the planner sees the user's intent without 30 lines of the same kind. */
function trimNoisyEvents(events: ActivityEvent[], cap: number): ActivityEvent[] {
  if (events.length <= cap) return events;
  // Keep all AI + system events; aggressively trim oldest user events.
  const ai = events.filter((e) => e.actor !== "user");
  const user = events.filter((e) => e.actor === "user");
  const keepUser = user.slice(-Math.max(cap - ai.length, 6));
  // Merge back preserving original order by ts.
  const merged = [...ai, ...keepUser].sort((a, b) => a.ts - b.ts);
  return merged;
}

/** Human-readable "3m ago" / "12s ago". */
export function formatAgo(deltaMs: number): string {
  const s = Math.round(deltaMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

function compactPayload(p: Record<string, unknown>): string {
  const keys = Object.keys(p);
  if (keys.length === 0) return "";
  const out: string[] = [];
  for (const k of keys.slice(0, 3)) {
    const v = p[k];
    if (v == null) continue;
    if (typeof v === "string") out.push(`${k}=${truncate(v, 24)}`);
    else if (typeof v === "number") out.push(`${k}=${formatNumber(v)}`);
    else if (typeof v === "boolean") out.push(`${k}=${v}`);
    else if (Array.isArray(v)) out.push(`${k}=[${v.length}]`);
    else out.push(`${k}={…}`);
  }
  return out.join(", ");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function formatNumber(n: number): string {
  if (!isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

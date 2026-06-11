// =====================================================================
// lib/briefing/followups.ts
//
// Normalize briefing follow-ups into structured BriefingFollowUp actions.
//
// The briefing API (and older persisted sessions) emit follow-ups as plain
// strings. The UI used to send those strings straight back through the
// chat pipe, forcing the cloud planner to RE-GUESS the user's intent from
// words on every click — the root cause of the "what should the short be
// about?" clarify loop after a briefing.
//
// This module upgrades each raw follow-up into a typed action that CARRIES
// its intent, so the app can run a deterministic path (promote / plan /
// extract) without a planner round-trip.
//
// Design rules (per project constraints):
//   - PURE + side-effect free. Safe to call on every render (BriefingCard
//     memoizes it).
//   - NO genre/keyword table. The only heuristic is a tiny, bounded set of
//     generic "use the moments I already found" phrasings (config:
//     BRIEFING_FOLLOWUP.promoteHints). Everything else defaults to a
//     `plan_topic` grounded in the briefing — the planner is never asked
//     to interpret raw text.
//   - Already-structured actions pass through untouched (forward-compatible
//     with a briefing API that one day returns structured follow-ups).
//   - Stable, index-derived ids so React keys don't churn across renders.
// =====================================================================

import { BRIEFING_FOLLOWUP } from "@/lib/config";
import type { BriefingFollowUp } from "@/lib/types";

const VALID_KINDS = new Set([
  "promote",
  "plan_topic",
  "extract_range",
  "chat"
]);

export interface NormalizeFollowUpContext {
  /** The source the briefing was about — grounds `plan_topic` /
   *  `extract_range` actions. May be undefined for single-source
   *  briefings (the action falls back to the active source downstream). */
  sourceId?: string;
}

/**
 * Convert a list of raw follow-ups (strings, already-structured actions,
 * or a mix) into clean BriefingFollowUp actions.
 *
 * @param raw  Whatever the briefing attachment carried. Defensive about
 *             unknown shapes because attachments survive session restore.
 * @param ctx  Grounding context (briefing source id).
 */
export function normalizeBriefingFollowUps(
  raw: unknown,
  ctx: NormalizeFollowUpContext = {}
): BriefingFollowUp[] {
  if (!Array.isArray(raw)) return [];
  const out: BriefingFollowUp[] = [];
  const sourceId = ctx.sourceId ?? "";

  raw.forEach((entry, index) => {
    const id = `fu_${index}`;

    // Already-structured action → keep it (sanitize id/label minimally).
    if (entry && typeof entry === "object") {
      const structured = sanitizeStructured(entry as Record<string, unknown>, id, sourceId);
      if (structured) out.push(structured);
      return;
    }

    // Plain string → upgrade into a structured action.
    if (typeof entry === "string") {
      const label = entry.trim().slice(0, 80);
      if (!label) return;
      out.push(fromString(label, id, sourceId));
    }
  });

  return out;
}

/** Map a free-text follow-up label to a structured action.
 *  Promote when it reads like "use the moments I already found";
 *  otherwise a planner-free `plan_topic` grounded in the briefing. */
function fromString(
  label: string,
  id: string,
  sourceId: string
): BriefingFollowUp {
  const lower = label.toLowerCase();
  const isPromote = BRIEFING_FOLLOWUP.promoteHints.some((hint) =>
    lower.includes(hint)
  );

  if (isPromote) {
    return { id, label, kind: "promote", op: "append" };
  }

  return {
    id,
    label,
    kind: "plan_topic",
    sourceId,
    topic: label,
    scenarioPrompt: label,
    signals: { ...BRIEFING_FOLLOWUP.planTopicSignals }
  };
}

/** Validate an already-structured follow-up object. Returns a clean action
 *  or null when the shape is unusable (the caller drops it). */
function sanitizeStructured(
  o: Record<string, unknown>,
  fallbackId: string,
  fallbackSourceId: string
): BriefingFollowUp | null {
  const kind = typeof o.kind === "string" ? o.kind : "";
  if (!VALID_KINDS.has(kind)) return null;

  const id =
    typeof o.id === "string" && o.id.trim() ? o.id.trim().slice(0, 48) : fallbackId;
  const label =
    typeof o.label === "string" && o.label.trim()
      ? o.label.trim().slice(0, 80)
      : "Continue";
  const sourceId =
    typeof o.sourceId === "string" && o.sourceId ? o.sourceId : fallbackSourceId;

  switch (kind) {
    case "promote": {
      const partIds = Array.isArray(o.partIds)
        ? o.partIds.filter((x): x is string => typeof x === "string").slice(0, 12)
        : undefined;
      const targetSeconds = finiteNum(o.targetSeconds);
      const op = o.op === "replace" ? "replace" : "append";
      return {
        id,
        label,
        kind: "promote",
        ...(partIds && partIds.length ? { partIds } : {}),
        ...(targetSeconds != null ? { targetSeconds } : {}),
        op
      };
    }
    case "plan_topic": {
      const topic =
        typeof o.topic === "string" && o.topic.trim() ? o.topic.trim().slice(0, 200) : label;
      const scenarioPrompt =
        typeof o.scenarioPrompt === "string" && o.scenarioPrompt.trim()
          ? o.scenarioPrompt.trim().slice(0, 200)
          : topic;
      const signals = sanitizeSignals(o.signals);
      return {
        id,
        label,
        kind: "plan_topic",
        sourceId,
        topic,
        scenarioPrompt,
        signals
      };
    }
    case "extract_range": {
      const start = finiteNum(o.startSeconds);
      const end = finiteNum(o.endSeconds);
      if (start == null || end == null || end <= start) return null;
      return {
        id,
        label,
        kind: "extract_range",
        sourceId,
        startSeconds: Math.max(0, start),
        endSeconds: Math.max(0, end)
      };
    }
    case "chat": {
      const text =
        typeof o.text === "string" && o.text.trim() ? o.text.trim().slice(0, 400) : label;
      return { id, label, kind: "chat", text };
    }
    default:
      return null;
  }
}

function sanitizeSignals(raw: unknown): {
  semantic: number;
  motion: number;
  saliency: number;
} {
  const fallback = { ...BRIEFING_FOLLOWUP.planTopicSignals };
  if (!raw || typeof raw !== "object") return fallback;
  const o = raw as Record<string, unknown>;
  const sem = finiteNum(o.semantic);
  const mot = finiteNum(o.motion);
  const sal = finiteNum(o.saliency);
  if (sem == null && mot == null && sal == null) return fallback;
  const s = Math.max(0, sem ?? 0);
  const m = Math.max(0, mot ?? 0);
  const l = Math.max(0, sal ?? 0);
  const sum = s + m + l;
  if (sum <= 0) return fallback;
  return { semantic: s / sum, motion: m / sum, saliency: l / sum };
}

function finiteNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const p = Number(v);
    if (Number.isFinite(p)) return p;
  }
  return null;
}

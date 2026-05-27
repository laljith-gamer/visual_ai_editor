"use client";

import { AlertTriangle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { logSystem } from "@/lib/log/recorders";
import { useEditorStore } from "@/hooks/useEditorStore";

interface Props {
  /** Quota usage as 0..1. Render only when > 0.7 (soft tier). */
  fraction: number;
  usage: number;
  limit: number;
}

const DISMISS_KEY = "ss:quota_banner_dismissed_until";

/**
 * Sticky top banner shown when the global LLM budget enters the soft-limit
 * tier. Dismiss is per-session (localStorage), and it auto-resets at UTC
 * midnight when the global counter rolls over.
 *
 * Logs a `system.quota.warning` event the first time it appears so the
 * planner can react to "we're tight on budget" implicitly.
 */
export function QuotaBanner({ fraction, usage, limit }: Props) {
  const sessionId = useEditorStore((s) => s.sessionId);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const until = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
    setDismissed(until > Date.now());
  }, []);

  useEffect(() => {
    if (!dismissed && sessionId) {
      logSystem({
        sessionId,
        kind: "quota.warning",
        payload: { layer: "global", usage, limit, fraction },
        summary: `Shared AI budget at ${Math.round(fraction * 100)}% (${usage}/${limit})`
      });
    }
    // Only re-fire when fraction changes meaningfully.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Math.round(fraction * 20), sessionId, dismissed]);

  if (dismissed || fraction < 0.7) return null;

  function dismissForToday() {
    if (typeof window === "undefined") return;
    const next = new Date();
    next.setUTCHours(24, 0, 0, 0);
    localStorage.setItem(DISMISS_KEY, String(next.getTime()));
    setDismissed(true);
  }

  const pct = Math.round(fraction * 100);
  const tone = fraction >= 0.9 ? "warn" : "info";

  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 14px",
        background:
          tone === "warn"
            ? "rgba(240, 193, 92, 0.12)"
            : "rgba(117, 167, 255, 0.10)",
        borderBottom: "1px solid var(--line)",
        color: "var(--text)",
        fontSize: 13
      }}
    >
      <AlertTriangle
        size={14}
        style={{ color: tone === "warn" ? "var(--warn)" : "var(--info)" }}
      />
      <span>
        Shared AI capacity is at <strong>{pct}%</strong> for today
        {fraction >= 0.9
          ? ". Responses will be slow until UTC midnight."
          : ". You may notice slower responses."}
      </span>
      <span className="spacer" style={{ flex: 1 }} />
      <button
        className="btn icon"
        onClick={dismissForToday}
        aria-label="Dismiss banner"
      >
        <X size={12} />
      </button>
    </div>
  );
}

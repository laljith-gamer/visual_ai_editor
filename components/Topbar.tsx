"use client";

import { useEffect, useState } from "react";
import {
  Sparkles,
  Plus,
  Activity as ActivityIcon,
  FileText,
  Moon,
  Sun
} from "lucide-react";
import { useEditorStore } from "@/hooks/useEditorStore";
import { useActivityLog } from "@/hooks/useActivityLog";
import { logUser } from "@/lib/log/recorders";
import { formatTime } from "@/lib/util/time";
import type { ActivityEvent } from "@/lib/types";
import { ModeBadge } from "./ModeBadge";
import styles from "./Topbar.module.css";

interface Props {
  /** Open the activity drawer. Owned by app/editor/page.tsx. */
  onOpenActivity: () => void;
  /** Number of new events since the user last opened the drawer. */
  newActivityCount?: number;
  /** v1.7.3 — Open the transcript drawer. Optional so callers that
   *  don't render TranscriptDrawer (none today, but future surfaces
   *  like a mobile-only layout) can omit. */
  onOpenTranscript?: () => void;
  /** v1.7.3 — Whether transcription is supported on this device. The
   *  button is hidden when false (low-tier devices / no Web Audio). */
  transcriptEnabled?: boolean;
}

type ThemeMode = "dark" | "light";

interface AiUsageSnapshot {
  totalCalls: number;
  plannerCalls: number;
  visionCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  byProvider: Record<
    string,
    {
      calls: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    }
  >;
  last: {
    provider: string;
    kind: "planner" | "vision";
    model: string;
    apiKeyName: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    at: number;
  } | null;
}

interface LocalAiUsage {
  ops: number;
  framesSampled: number;
  framesScored: number;
  lastKind?: string;
  lastTier?: string;
}

const THEME_STORAGE_KEY = "shorts-studio.theme";

export function Topbar({
  onOpenActivity,
  newActivityCount = 0,
  onOpenTranscript,
  transcriptEnabled
}: Props) {
  const status = useEditorStore((s) => s.status);
  const highlights = useEditorStore((s) => s.highlights);
  const plan = useEditorStore((s) => s.plan);
  const mode = useEditorStore((s) => s.mode);
  const inferred = useEditorStore((s) => s.inferred);
  const newSession = useEditorStore((s) => s.newSession);
  const sessionId = useEditorStore((s) => s.sessionId);
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [aiUsage, setAiUsage] = useState<AiUsageSnapshot | null>(null);

  // Make sure the activity log stays bound even on this lightweight component;
  // the read is cheap and ensures the singleton is initialized for the active session.
  const activityEvents = useActivityLog(sessionId);
  const localAiUsage = summarizeLocalAiUsage(activityEvents);

  useEffect(() => {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "dark" || saved === "light") {
      setTheme(saved);
      return;
    }
    const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)").matches;
    setTheme(prefersLight ? "light" : "dark");
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const refreshUsage = async () => {
      try {
        const res = await fetch("/api/ai/usage", { cache: "no-store" });
        if (!res.ok) return;
        const snapshot = (await res.json()) as AiUsageSnapshot;
        if (!cancelled) setAiUsage(snapshot);
      } catch {
        // Usage telemetry is informational only; never disturb the editor UI.
      }
    };

    void refreshUsage();
    timer = window.setInterval(() => {
      void refreshUsage();
    }, 5000);

    return () => {
      cancelled = true;
      if (typeof timer === "number") window.clearInterval(timer);
    };
  }, []);

  const totalDuration = highlights.reduce(
    (acc, h) => acc + (h.end - h.start),
    0
  );
  const sampleCount = plan
    ? Math.floor((plan.targetShortSeconds * 4) / plan.sampleEverySeconds)
    : 0;
  const nextTheme = theme === "dark" ? "light" : "dark";

  return (
    <header className={styles.topbar}>
      <div className={styles.brand}>
        <div className={styles.brandMark}>
          <Sparkles size={18} />
        </div>
        <div className={styles.brandCopy}>
          <p className="eyebrow">Universal Video Shorts Editor</p>
          <div className={styles.brandTitleRow}>
            <h1>Shorts Studio</h1>
            <AiUsagePill usage={aiUsage} localUsage={localAiUsage} />
          </div>
        </div>
      </div>

      <div className={styles.actions}>
        <button
          className={styles.newChatBtn}
          onClick={() => {
            logUser({
              sessionId,
              kind: "session.reset",
              payload: {},
              summary: "Started a new chat (state reset)"
            });
            newSession();
          }}
          title="Clear the conversation and start fresh"
        >
          <Plus size={14} strokeWidth={2.5} />
          <span>New chat</span>
        </button>

        <button
          className={styles.iconBtn}
          onClick={() => setTheme(nextTheme)}
          aria-label={`Switch to ${nextTheme} mode`}
          title={`Switch to ${nextTheme} mode`}
        >
          {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
          <span className={styles.iconBtnLabel}>
            {theme === "dark" ? "Light" : "Dark"}
          </span>
        </button>

        <button
          className={styles.iconBtn}
          onClick={onOpenActivity}
          aria-label="Open activity log"
          title="Activity log"
        >
          <ActivityIcon size={14} />
          <span className={styles.iconBtnLabel}>Activity</span>
          {newActivityCount > 0 && (
            <span aria-hidden className={styles.activityDot} />
          )}
        </button>

        {onOpenTranscript && transcriptEnabled !== false && (
          <button
            className={styles.iconBtn}
            onClick={onOpenTranscript}
            aria-label="Open transcript"
            title="Transcript"
          >
            <FileText size={14} />
            <span className={styles.iconBtnLabel}>Transcript</span>
          </button>
        )}

        <ModeBadge mode={mode} />
        {inferred.length > 0 && (
          <span
            className="pill info"
            title={inferred.map((f) => `${f.field}: ${f.reason}`).join("\n")}
          >
            {inferred.length} inferred
          </span>
        )}
        {sampleCount > 0 && <span className="pill">{sampleCount} samples</span>}
        {totalDuration > 0 && (
          <span className="pill accent">
            {formatTime(totalDuration)} selected
          </span>
        )}
        <span className={`pill ${statusToClass(status)}`}>
          {labelStatus(status)}
        </span>
      </div>
    </header>
  );
}

function AiUsagePill({
  usage,
  localUsage
}: {
  usage: AiUsageSnapshot | null;
  localUsage: LocalAiUsage;
}) {
  const calls = usage?.totalCalls ?? 0;
  const tokenText = calls > 0
    ? usage && usage.totalTokens > 0
      ? `${formatCompactNumber(usage.totalTokens)} tok`
      : "tokens n/a"
    : "0 tok";
  const last = usage?.last;
  const apiLabel = last
    ? `${last.provider} · ${shortModel(last.model)}`
    : "no API call yet";
  const localText = localUsage.ops > 0
    ? ` · Local ${formatCompactNumber(localUsage.ops)} ops`
    : "";
  const title = buildUsageTitle(usage, localUsage);

  return (
    <span className={styles.aiUsagePill} title={title} aria-label={title}>
      <span className={styles.aiUsageDot} aria-hidden />
      <span className={styles.aiUsageText}>
        API {calls} call{calls === 1 ? "" : "s"} · {tokenText}{localText} · {apiLabel}
      </span>
    </span>
  );
}

function buildUsageTitle(
  usage: AiUsageSnapshot | null,
  localUsage: LocalAiUsage
): string {
  const providerLines = Object.entries(usage?.byProvider ?? {})
    .sort((a, b) => b[1].calls - a[1].calls)
    .map(
      ([provider, bucket]) =>
        `${provider}: ${bucket.calls} calls, ${formatNumber(bucket.totalTokens)} tokens`
    );
  const last = usage?.last
    ? [
        `Last API provider: ${usage.last.provider}`,
        `Last API model: ${usage.last.model}`,
        `API key source: ${usage.last.apiKeyName} (secret value hidden)`,
        `Last API call type: ${usage.last.kind}`,
        `Last API tokens: ${formatNumber(usage.last.totalTokens ?? 0)} total (${formatNumber(usage.last.inputTokens ?? 0)} in / ${formatNumber(usage.last.outputTokens ?? 0)} out)`
      ]
    : ["Last API provider: none yet", "API key source: none used yet"];

  return [
    "Server AI API usage",
    `API calls: ${usage?.totalCalls ?? 0}`,
    `Planner API calls: ${usage?.plannerCalls ?? 0}`,
    `Vision API calls: ${usage?.visionCalls ?? 0}`,
    `API tokens: ${formatNumber(usage?.totalTokens ?? 0)} (${formatNumber(usage?.inputTokens ?? 0)} in / ${formatNumber(usage?.outputTokens ?? 0)} out)`,
    ...last,
    "",
    "Local/session AI activity",
    `Ops: ${localUsage.ops}`,
    `Frames sampled: ${formatNumber(localUsage.framesSampled)}`,
    `Frames scored: ${formatNumber(localUsage.framesScored)}`,
    `Last local/session op: ${localUsage.lastKind ?? "none"}`,
    `Last local/session tier: ${localUsage.lastTier ?? "none"}`,
    "Local/browser work uses no server API key.",
    ...(providerLines.length > 0 ? ["", "By API provider:", ...providerLines] : [])
  ].join("\n");
}

function summarizeLocalAiUsage(events: ActivityEvent[]): LocalAiUsage {
  let ops = 0;
  let framesSampled = 0;
  let framesScored = 0;
  let lastKind: string | undefined;
  let lastTier: string | undefined;

  for (const event of events) {
    if (event.actor !== "ai") continue;
    const multiplier = event.count ?? 1;
    ops += multiplier;
    lastKind = event.kind;

    const payloadCount = numericPayload(event.payload, "count") ?? 0;
    if (event.kind === "frames.sampled") {
      framesSampled += payloadCount * multiplier;
    }
    if (event.kind === "frames.scored") {
      framesScored += payloadCount * multiplier;
      const tier = stringPayload(event.payload, "tier");
      if (tier) lastTier = tier;
    }
  }

  return { ops, framesSampled, framesScored, lastKind, lastTier };
}

function numericPayload(
  payload: Record<string, unknown>,
  key: string
): number | undefined {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringPayload(
  payload: Record<string, unknown>,
  key: string
): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function shortModel(model: string): string {
  if (model.length <= 28) return model;
  const parts = model.split("/");
  const tail = parts[parts.length - 1] || model;
  return tail.length <= 28 ? tail : `${tail.slice(0, 25)}…`;
}

function formatCompactNumber(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${round1(n / 1_000_000)}M`;
  if (n >= 1_000) return `${round1(n / 1_000)}K`;
  return String(Math.round(n));
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const rounded = String(Math.round(n));
  return rounded.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function round1(n: number): string {
  return n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

function statusToClass(s: string): string {
  if (s === "completed" || s === "ready") return "accent";
  if (s === "failed") return "warn";
  if (s === "needs_review") return "warn";
  if (s === "idle") return "";
  return "info";
}
function labelStatus(s: string): string {
  return (
    {
      idle: "ready to plan",
      planning: "planning",
      sampling: "sampling frames",
      scoring: "scoring frames",
      temporal: "judging windows",
      selecting: "picking clips",
      ready: "ready to render",
      needs_review: "needs review",
      rendering: "rendering",
      completed: "done",
      failed: "failed"
    }[s] ?? s
  );
}

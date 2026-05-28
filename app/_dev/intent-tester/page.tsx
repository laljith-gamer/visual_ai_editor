"use client";

import { useEffect, useMemo, useState } from "react";
import { quickMatch } from "@/lib/intent/quickMatch";
import { useEditorStore } from "@/hooks/useEditorStore";
import type { QuickMatch, QuickMatchContext } from "@/lib/intent/types";

/**
 * v1.7.5 — Dev-only intent tester.
 *
 * Live-evaluates the grammar matcher against arbitrary phrases using
 * the current editor state as the context (sources, highlights,
 * lastBriefing, etc.). Useful for tuning patterns + thresholds without
 * spinning up the full chat flow.
 *
 * Gated by NODE_ENV: production builds short-circuit to a 404-style
 * card. Dev navigation is /\_dev/intent-tester.
 *
 * No styling beyond inline because this is a contributor tool, not a
 * user-facing surface. Keeps the bundle hit minimal.
 */

const SAMPLES = [
  "merge the videos",
  "just merge them",
  "merge whole videos no edit",
  "stitch the podcast then the b-roll",
  "concatenate them",
  "first 30 seconds",
  "last 10s",
  "from 0:30 to 1:45",
  "give me the first minute",
  "trim first 30 seconds",
  "drop 0:30 to 0:45",
  "split this clip",
  "split at 1:00",
  "reset video 1",
  "clip those",
  "use the briefing",
  "make a 15s reel of these",
  "use the second one",
  "yes",
  "go ahead",
  "do it",
  "cancel",
  "never mind",
  "best parts",
  "highlights please",
  "the funny moments",
  "describe the video",
  "make it 30s"
];

export default function IntentTesterPage() {
  const isDev = process.env.NODE_ENV !== "production";
  const [text, setText] = useState("merge the videos");
  const sources = useEditorStore((s) => s.sources);
  const selectedSourceIds = useEditorStore((s) => s.selectedSourceIds);
  const highlights = useEditorStore((s) => s.highlights);
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const lastBriefing = useEditorStore((s) => s.lastBriefing);
  const pendingExecution = useEditorStore((s) => s.pendingExecution);
  const pendingClarify = useEditorStore((s) => s.pendingClarify);
  const messages = useEditorStore((s) => s.messages);

  // Build the QuickMatchContext in the same shape lib/intent/dispatch.ts
  // does. We deliberately don't import buildContext from there to keep
  // dispatch.ts free of React concerns.
  const ctx = useMemo<QuickMatchContext>(() => {
    const prev = [...messages].reverse().find((m) => m.role === "assistant");
    return {
      sources: sources.map((s) => ({
        id: s.id,
        meta: { name: s.meta.name, duration: s.meta.duration }
      })),
      selectedSourceIds: [...selectedSourceIds],
      highlights: highlights.map((h) => ({
        id: h.id,
        start: h.start,
        end: h.end,
        sourceId: h.sourceId,
        label: h.label
      })),
      selectedClipId,
      lastBriefing: lastBriefing
        ? {
            sourceId: lastBriefing.sourceId,
            bestParts: lastBriefing.bestParts.map((p) => ({
              id: p.id,
              startSeconds: p.startSeconds,
              endSeconds: p.endSeconds,
              label: p.label
            }))
          }
        : null,
      pendingExecution,
      pendingClarify: !!pendingClarify,
      prevAssistantText: prev?.content
    };
  }, [
    sources,
    selectedSourceIds,
    highlights,
    selectedClipId,
    lastBriefing,
    pendingExecution,
    pendingClarify,
    messages
  ]);

  const result = useMemo(() => quickMatch(text, ctx), [text, ctx]);

  if (!isDev) {
    return (
      <main style={notFoundStyle}>
        <div style={cardStyle}>
          <h1 style={{ margin: 0 }}>Not found</h1>
          <p style={{ color: "#888" }}>
            The intent tester is only available in development builds.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main style={shellStyle}>
      <header style={headerStyle}>
        <h1 style={{ margin: 0, fontSize: 18 }}>Intent Tester</h1>
        <span style={{ color: "#888", fontSize: 12 }}>
          dev-only · client-side matcher · threshold 0.85
        </span>
      </header>

      <section style={panelStyle}>
        <label style={labelStyle}>User input</label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          style={inputStyle}
          placeholder="Type a phrase to test..."
        />

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          {SAMPLES.map((s) => (
            <button
              key={s}
              type="button"
              style={sampleBtnStyle}
              onClick={() => setText(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </section>

      <section style={panelStyle}>
        <h2 style={sectionTitleStyle}>Result</h2>
        <ResultBox match={result.match} />
      </section>

      <section style={panelStyle}>
        <h2 style={sectionTitleStyle}>All candidates ({result.candidates.length})</h2>
        {result.candidates.length === 0 ? (
          <p style={{ color: "#888" }}>No pattern fired.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {result.candidates.map((c, i) => (
              <li
                key={`${c.kind}-${i}`}
                style={{
                  ...candidateRowStyle,
                  background:
                    c.confidence >= 0.85
                      ? "rgba(99, 216, 149, 0.08)"
                      : "rgba(255, 255, 255, 0.02)"
                }}
              >
                <strong>{c.kind}</strong>{" "}
                <span style={{ color: "#888" }}>({c.patternId})</span>
                <span style={{ marginLeft: "auto", fontFamily: "monospace" }}>
                  {(c.confidence * 100).toFixed(0)}%
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={panelStyle}>
        <h2 style={sectionTitleStyle}>Context snapshot</h2>
        <pre style={preStyle}>
          {JSON.stringify(
            {
              sources: ctx.sources.length,
              selected: ctx.selectedSourceIds.length,
              highlights: ctx.highlights.length,
              selectedClip: ctx.selectedClipId,
              hasBriefing: !!ctx.lastBriefing,
              briefingParts: ctx.lastBriefing?.bestParts.length ?? 0,
              pendingExecution: ctx.pendingExecution,
              pendingClarify: ctx.pendingClarify
            },
            null,
            2
          )}
        </pre>
      </section>
    </main>
  );
}

function ResultBox({ match }: { match: QuickMatch | null }) {
  if (!match) {
    return (
      <div style={{ ...resultBoxStyle, borderColor: "rgba(255,255,255,0.08)" }}>
        <strong>No match</strong>
        <span style={{ color: "#888" }}>
          {" "}
          — falls through to cloud planner
        </span>
      </div>
    );
  }
  return (
    <div
      style={{
        ...resultBoxStyle,
        borderColor: "rgba(99, 216, 149, 0.5)"
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <strong style={{ fontSize: 16 }}>{match.kind}</strong>
        <span style={{ color: "#888", fontFamily: "monospace" }}>
          {match.patternId}
        </span>
        <span style={{ marginLeft: "auto", color: "var(--accent, #63d895)" }}>
          {(match.confidence * 100).toFixed(0)}%
        </span>
      </div>
      <pre style={preStyle}>{JSON.stringify(match, null, 2)}</pre>
    </div>
  );
}

// ---- Inline styles (dev tool, not user-facing) ----

const shellStyle: React.CSSProperties = {
  background: "var(--bg-0, #0b0d10)",
  color: "var(--text, #f4f2ed)",
  minHeight: "100dvh",
  padding: 24,
  fontFamily:
    "ui-sans-serif, system-ui, -apple-system, sans-serif"
};
const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  marginBottom: 24,
  borderBottom: "1px solid rgba(255,255,255,0.06)",
  paddingBottom: 16
};
const panelStyle: React.CSSProperties = {
  marginBottom: 20,
  padding: 16,
  background: "var(--bg-1, #11151a)",
  border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: 12
};
const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  letterSpacing: "0.16em",
  textTransform: "uppercase",
  color: "#888",
  marginBottom: 8
};
const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: 10,
  fontSize: 14,
  fontFamily: "inherit",
  background: "rgba(0,0,0,0.4)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 8,
  resize: "vertical",
  boxSizing: "border-box"
};
const sampleBtnStyle: React.CSSProperties = {
  padding: "5px 10px",
  fontSize: 11,
  background: "rgba(255,255,255,0.04)",
  color: "var(--text-muted, #b3ad9f)",
  border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: 999,
  cursor: "pointer"
};
const sectionTitleStyle: React.CSSProperties = {
  margin: "0 0 12px",
  fontSize: 13,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "#888"
};
const resultBoxStyle: React.CSSProperties = {
  padding: 14,
  background: "rgba(0,0,0,0.3)",
  border: "1px solid",
  borderRadius: 8
};
const candidateRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "8px 12px",
  borderRadius: 6,
  marginBottom: 4,
  fontSize: 13
};
const preStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, monospace",
  fontSize: 11,
  background: "rgba(0,0,0,0.4)",
  padding: 12,
  borderRadius: 6,
  margin: "8px 0 0",
  overflowX: "auto",
  border: "1px solid rgba(255,255,255,0.04)"
};
const notFoundStyle: React.CSSProperties = {
  ...shellStyle,
  display: "grid",
  placeItems: "center"
};
const cardStyle: React.CSSProperties = {
  ...panelStyle,
  textAlign: "center",
  marginBottom: 0
};

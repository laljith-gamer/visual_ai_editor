"use client";

import { useEffect, useMemo, useState } from "react";
import { quickMatch } from "@/lib/intent/quickMatch";
import { useEditorStore } from "@/hooks/useEditorStore";
import type { QuickMatch, QuickMatchContext } from "@/lib/intent/types";

/**
 * v1.8.0 — Dev-only intent tester.
 *
 * AI-powered intent understanding using system prompts (NO hardcoded patterns).
 * Toggle between "Pattern Matcher" (legacy) and "AI Intent" (new).
 *
 * Gated by NODE_ENV: production builds short-circuit to a 404-style card.
 * Dev navigation is /\_dev/intent-tester.
 */

interface AIIntentResult {
  action: string;
  target: string;
  parameters: Record<string, any>;
  confidence: number;
  needs_clarification: boolean;
  question?: string;
  reasoning?: string;
}

export default function IntentTesterPage() {
  const isDev = process.env.NODE_ENV !== "production";
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"pattern" | "ai">("ai");
  const [aiResult, setAiResult] = useState<AIIntentResult | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const sources = useEditorStore((s) => s.sources);
  const selectedSourceIds = useEditorStore((s) => s.selectedSourceIds);
  const highlights = useEditorStore((s) => s.highlights);
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const lastBriefing = useEditorStore((s) => s.lastBriefing);
  const pendingExecution = useEditorStore((s) => s.pendingExecution);
  const pendingClarify = useEditorStore((s) => s.pendingClarify);
  const messages = useEditorStore((s) => s.messages);

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

  const analyzeWithAI = async () => {
    setAiLoading(true);
    setAiError(null);
    try {
      const response = await fetch("/api/agent/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: "understand",
          userMessage: text,
          context: {
            uploadedVideos: sources.length,
            selectedVideos: selectedSourceIds.length,
            timelineClips: highlights.length,
            timelineEmpty: highlights.length === 0,
            hasPendingAction: !!pendingExecution
          }
        })
      });
      
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      
      const data = await response.json();
      setAiResult(data);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiLoading(false);
    }
  };

  useEffect(() => {
    if (mode === "ai" && text.trim()) {
      const timer = setTimeout(() => {
        analyzeWithAI();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [text, mode]);

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
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <span style={{ color: "#888", fontSize: 12 }}>dev-only · no hardcoded patterns</span>
          <div style={{ display: "flex", gap: 4, background: "rgba(0,0,0,0.3)", borderRadius: 6, padding: 2 }}>
            <button
              type="button"
              style={{
                ...modeBtnStyle,
                background: mode === "pattern" ? "rgba(99, 216, 149, 0.15)" : "transparent",
                color: mode === "pattern" ? "var(--accent, #63d895)" : "#888"
              }}
              onClick={() => setMode("pattern")}
            >
              Pattern Matcher
            </button>
            <button
              type="button"
              style={{
                ...modeBtnStyle,
                background: mode === "ai" ? "rgba(99, 216, 149, 0.15)" : "transparent",
                color: mode === "ai" ? "var(--accent, #63d895)" : "#888"
              }}
              onClick={() => setMode("ai")}
            >
              AI Intent
            </button>
          </div>
        </div>
      </header>

      <section style={panelStyle}>
        <label style={labelStyle}>User input</label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          style={inputStyle}
          placeholder="Type what you want to do... (e.g., 'merge the podcast then trim the first 30 seconds')"
        />
      </section>

      {mode === "pattern" ? (
        <>
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
        </>
      ) : (
        <section style={panelStyle}>
          <h2 style={sectionTitleStyle}>AI Intent Understanding</h2>
          {aiLoading ? (
            <div style={{ color: "#888", padding: 14 }}>Analyzing...</div>
          ) : aiError ? (
            <div style={{ ...resultBoxStyle, borderColor: "rgba(255, 99, 71, 0.5)" }}>
              <strong style={{ color: "#ff6347" }}>Error</strong>
              <p style={{ margin: "8px 0 0", color: "#888" }}>{aiError}</p>
            </div>
          ) : aiResult ? (
            <AIResultBox result={aiResult} />
          ) : (
            <div style={{ color: "#888", padding: 14, fontStyle: "italic" }}>
              Type a command to see AI understanding...
            </div>
          )}
        </section>
      )}

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

function AIResultBox({ result }: { result: AIIntentResult }) {
  return (
    <div
      style={{
        ...resultBoxStyle,
        borderColor: result.confidence >= 0.7 ? "rgba(99, 216, 149, 0.5)" : "rgba(255, 193, 7, 0.5)"
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
        <strong style={{ fontSize: 16 }}>{result.action}</strong>
        {result.target && (
          <span style={{ color: "#888" }}>→ {result.target}</span>
        )}
        <span style={{ marginLeft: "auto", color: result.confidence >= 0.7 ? "var(--accent, #63d895)" : "#ffc107" }}>
          {(result.confidence * 100).toFixed(0)}%
        </span>
      </div>

      {result.needs_clarification && result.question && (
        <div style={{
          padding: 10,
          background: "rgba(255, 193, 7, 0.1)",
          border: "1px solid rgba(255, 193, 7, 0.3)",
          borderRadius: 6,
          marginBottom: 12
        }}>
          <strong style={{ color: "#ffc107", fontSize: 12 }}>NEEDS CLARIFICATION</strong>
          <p style={{ margin: "6px 0 0", color: "#f4f2ed" }}>{result.question}</p>
        </div>
      )}

      {result.reasoning && (
        <div style={{
          padding: 10,
          background: "rgba(99, 216, 149, 0.05)",
          border: "1px solid rgba(99, 216, 149, 0.15)",
          borderRadius: 6,
          marginBottom: 12
        }}>
          <strong style={{ color: "#63d895", fontSize: 11, letterSpacing: "0.1em" }}>REASONING</strong>
          <p style={{ margin: "6px 0 0", color: "#b3ad9f", fontSize: 13 }}>{result.reasoning}</p>
        </div>
      )}

      {Object.keys(result.parameters).length > 0 && (
        <>
          <strong style={{ fontSize: 11, color: "#888", letterSpacing: "0.1em", display: "block", marginBottom: 8 }}>PARAMETERS</strong>
          <pre style={preStyle}>{JSON.stringify(result.parameters, null, 2)}</pre>
        </>
      )}
    </div>
  );
}

// Inline styles
const shellStyle: React.CSSProperties = {
  background: "var(--bg-0, #0b0d10)",
  color: "var(--text, #f4f2ed)",
  minHeight: "100dvh",
  padding: 24,
  fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif"
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
const modeBtnStyle: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: 11,
  fontWeight: 500,
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  transition: "all 0.2s"
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

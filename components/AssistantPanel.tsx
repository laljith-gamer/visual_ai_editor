"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  Copy,
  Download,
  Film,
  RotateCcw,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Zap
} from "lucide-react";
import { useEditorStore } from "@/hooks/useEditorStore";
import { useShare } from "@/hooks/useShare";
import { CapabilityBadge } from "./CapabilityBadge";
import { AIModeBadge } from "./AIModeBadge";
import { BrainToggle } from "./BrainToggle";
import { AnalysisModeToggle } from "./AnalysisModeToggle";
import { PlanPreview } from "./PlanPreview";
import { BriefingCard } from "./BriefingCard";
import { logUser } from "@/lib/log/recorders";
import type {
  BestPart,
  BriefingFollowUp,
  ChatMessage,
  InferredField
} from "@/lib/types";
import styles from "./AssistantPanel.module.css";

interface Props {
  onSubmit: (text: string) => Promise<void>;
  onOpenClips: () => void;
  /** Confirm the pending plan and start the analysis pipeline. */
  onRunPlan: () => void;
  /** v1.8.1 — Execute a structured briefing follow-up action (promote /
   *  plan_topic / extract_range) deterministically, without sending raw
   *  text through the planner. `chat` actions are NOT routed here — they
   *  go through the normal chat pipe (onSubmit) so typed chat and chip
   *  chat behave identically. */
  onBriefingAction: (action: BriefingFollowUp) => void;
  isBusy: boolean;
}

/**
 * AssistantPanel — the chat surface that sits to the right of the
 * editor stage. Visually rebuilt around the "Smart Chat" template the
 * user picked: pill-shaped composer, action bar under each assistant
 * message, in-flow suggestion chips. Functionally identical to the
 * previous panel — every behaviour (clarify questions, plan preview,
 * inferred badges, starter prompts, share/export buttons) still works.
 *
 * v1.7.0 changes:
 *   - Removed the Fast / Think toggle. Auto-mode is implicit: the
 *     server-side planner decides per-turn how proactive to be, and
 *     the new memory layer carries user intent across turns so the
 *     assistant doesn't re-ask templated questions.
 *   - Renders a BriefingCard inline for assistant messages whose
 *     attachment.mode === "briefing" (overview + best parts +
 *     follow-up actions).
 *   - Per-message action bar: Copy / Regenerate / Thumbs up / down.
 *     Copy uses the Clipboard API. Regenerate re-sends the most recent
 *     user turn through the existing onSubmit pipe. Thumbs feedback is
 *     logged to the activity stream via logUser.
 *
 * Image upload is intentionally absent — this panel is text-only.
 */

export function AssistantPanel({
  onSubmit,
  onOpenClips,
  onRunPlan,
  onBriefingAction,
  isBusy
}: Props) {
  const messages = useEditorStore((s) => s.messages);
  const renderedBlob = useEditorStore((s) => s.renderedBlob);
  const inferred = useEditorStore((s) => s.inferred);
  const pendingClarify = useEditorStore((s) => s.pendingClarify);
  const pendingExecution = useEditorStore((s) => s.pendingExecution);
  const sessionId = useEditorStore((s) => s.sessionId);

  const [text, setText] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, "up" | "down">>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const share = useShare();

  // Most-recent user message — needed for the Regenerate action.
  const lastUserText = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return messages[i].content;
    }
    return null;
  }, [messages]);

  // Auto-scroll to the latest message whenever the conversation grows
  // or a new inline card (clarify / plan-confirm) appears.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, pendingClarify, pendingExecution]);

  // Auto-resize the composer textarea up to ~5 rows of content. We
  // can't rely on `field-sizing: content` (Chromium-only as of 2025)
  // so we measure scrollHeight every keystroke. Cheap on this scale.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = 5 * 22; // ~5 rows at 22px line height
    el.style.height = Math.min(max, el.scrollHeight) + "px";
  }, [text]);

  async function send(value?: string, source: "typed" | "quickreply" | "regenerate" = "typed") {
    const trimmed = (value ?? text).trim();
    if (!trimmed || isBusy) return;
    if (source === "typed") setText("");
    if (source === "quickreply") {
      logUser({
        sessionId,
        kind: "quickreply.picked",
        payload: { suggestion: trimmed },
        summary: `Picked suggestion: "${truncate(trimmed, 40)}"`
      });
    } else if (source === "regenerate") {
      logUser({
        sessionId,
        kind: "chat.regenerated",
        payload: { text: trimmed },
        summary: `Regenerated: "${truncate(trimmed, 60)}"`
      });
    } else {
      logUser({
        sessionId,
        kind: "chat.sent",
        payload: { text: trimmed },
        summary: `Said: "${truncate(trimmed, 60)}"`
      });
    }
    await onSubmit(trimmed);
  }

  function handleCopy(m: ChatMessage) {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard.writeText(m.content).then(() => {
      setCopiedId(m.id);
      setTimeout(() => {
        setCopiedId((cur) => (cur === m.id ? null : cur));
      }, 1500);
    });
  }

  function handleRegenerate() {
    if (!lastUserText || isBusy) return;
    void send(lastUserText, "regenerate");
  }

  function handleFeedback(m: ChatMessage, kind: "up" | "down") {
    setFeedback((prev) => ({ ...prev, [m.id]: kind }));
    logUser({
      sessionId,
      kind: "chat.feedback",
      payload: { messageId: m.id, kind, snippet: m.content.slice(0, 120) },
      summary: `Marked an answer ${kind === "up" ? "helpful" : "unhelpful"}`
    });
  }

  const placeholder = pendingClarify
    ? "Type your answer\u2026"
    : pendingExecution
      ? "Adjust the plan in plain English (e.g. \u201Cmake it 60s\u201D)\u2026"
      : "Message your editor\u2026 (e.g. \u201Conly the lab scenes, 1 min\u201D)";

  const sendLabel = isBusy ? "Working\u2026" : "Send";

  return (
    <aside className={`assistant ${styles.panel}`}>
      {/* ─── Compact header ────────────────────────────────────── */}
      <div className={styles.header}>
        <div className={styles.title}>
          <span className={styles.titleIcon} aria-hidden>
            <Sparkles size={14} />
          </span>
          <span className={styles.titleText}>Smart Chat</span>
          <span className={styles.autoTag} title="Auto mode: the assistant decides per turn how deeply to think">
            Auto
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <AnalysisModeToggle />
          <BrainToggle />
          <AIModeBadge />
          <CapabilityBadge />
        </div>
      </div>

      {/* ─── Conversation scroller ────────────────────────────── */}
      <div ref={scrollRef} className={`${styles.messages} scroll-y`}>
        {messages.map((m, i) => {
          const isAssistant = m.role === "assistant";
          const isLast = i === messages.length - 1;
          // v1.7.0 — the editor page tags briefing-mode replies with a
          // structured attachment so AssistantPanel can render them as
          // a Smart-summary card instead of a flat text bubble.
          const briefingAttachment = readBriefingAttachment(m.attachment);
          return (
            <div
              key={m.id}
              className={`${styles.row} ${isAssistant ? styles.rowAssistant : styles.rowUser}`}
            >
              {isAssistant && (
                <span className={styles.avatar} aria-hidden>
                  <Sparkles size={12} />
                </span>
              )}
              <div className={styles.bubbleWrap}>
                <div className={styles.bubble}>{m.content}</div>
                {isAssistant && briefingAttachment && (
                  <BriefingCard
                    bestParts={briefingAttachment.bestParts}
                    followUps={briefingAttachment.followUps}
                    sourceId={briefingAttachment.sourceId}
                    onPickFollowUp={(action) => {
                      // chat follow-ups go through the normal chat pipe so
                      // typed chat and chip-chat are identical; every other
                      // (deterministic) action is executed by the page.
                      if (action.kind === "chat") {
                        void send(action.text, "quickreply");
                      } else {
                        onBriefingAction(action);
                      }
                    }}
                    disabled={isBusy}
                  />
                )}
                {isAssistant && (
                  <MessageActions
                    copied={copiedId === m.id}
                    canRegenerate={isLast && !!lastUserText && !isBusy}
                    feedback={feedback[m.id]}
                    onCopy={() => handleCopy(m)}
                    onRegenerate={handleRegenerate}
                    onFeedback={(k) => handleFeedback(m, k)}
                    shortcut={readShortcutAttachment(m.attachment)}
                  />
                )}
              </div>
            </div>
          );
        })}

        {/* Typing indicator while the agent is working. Kept outside
            of the messages list so it doesn't pollute the persisted
            conversation history. */}
        {isBusy && (
          <div className={`${styles.row} ${styles.rowAssistant}`}>
            <span className={styles.avatar} aria-hidden>
              <Sparkles size={12} />
            </span>
            <div className={styles.bubbleWrap}>
              <div className={`${styles.bubble} ${styles.typing}`}>
                <span className={styles.dot} />
                <span className={styles.dot} />
                <span className={styles.dot} />
                <span className={styles.typingLabel}>{"Working\u2026"}</span>
              </div>
            </div>
          </div>
        )}

        {inferred.length > 0 && !pendingClarify && (
          <InferredBadges fields={inferred} />
        )}

        {pendingExecution && !pendingClarify && (
          <PlanPreview
            onRun={onRunPlan}
            onAdjust={() => composerRef.current?.focus()}
            disabled={isBusy}
          />
        )}
      </div>

      {/* ─── Composer (pill input + send button) ──────────────── */}
      <div className={styles.composerWrap}>
        <div
          className={`${styles.composer} ${isBusy ? styles.composerBusy : ""}`}
        >
          <textarea
            ref={composerRef}
            className={styles.input}
            placeholder={placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            aria-label="Ask the assistant"
          />
          <button
            type="button"
            className={styles.sendBtn}
            onClick={() => void send()}
            disabled={isBusy || !text.trim()}
            aria-label={sendLabel}
            title={sendLabel}
          >
            <ArrowUp size={16} strokeWidth={2.5} />
          </button>
        </div>
        <p className={styles.hint}>
          <kbd>Enter</kbd> to send, <kbd>Shift</kbd>+<kbd>Enter</kbd> for newline
        </p>
      </div>

      {/* ─── Footer actions ───────────────────────────────────── */}
      <div className={styles.footer}>
        <button className={styles.footerBtn} onClick={onOpenClips}>
          <Film size={13} /> Clips
        </button>
        <div className="spacer" />
        {renderedBlob && (
          <button
            className={`${styles.footerBtn} ${styles.footerBtnAccent}`}
            onClick={() =>
              void share({
                blob: renderedBlob,
                filename: "shorts-studio.mp4",
                title: "Shorts Studio export"
              })
            }
          >
            <Download size={13} /> Export Short
          </button>
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------

/**
 * Read a chat message's attachment as a briefing payload, or return
 * null if the shape doesn't match. Defensive about runtime types
 * because attachments survive session restore (IDB) and could be
 * partially populated by older code paths.
 *
 * v1.8.1 — follow-ups may now be plain strings (legacy / current API)
 * OR structured BriefingFollowUp actions. We keep BOTH shapes here and
 * let BriefingCard normalize them, so old saved sessions (string[]) and
 * any future structured payloads both render. The source id is surfaced
 * so legacy strings can be grounded into plan_topic / extract_range
 * actions.
 */
function readBriefingAttachment(
  raw: ChatMessage["attachment"]
): {
  bestParts: BestPart[];
  followUps: Array<string | BriefingFollowUp>;
  sourceId?: string;
} | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.mode !== "briefing") return null;
  const bp = Array.isArray(raw.bestParts) ? (raw.bestParts as BestPart[]) : [];
  const fu = Array.isArray(raw.followUps)
    ? (raw.followUps as Array<string | BriefingFollowUp>).filter(
        (f) => typeof f === "string" || (f && typeof f === "object")
      )
    : [];
  if (bp.length === 0 && fu.length === 0) return null;
  const sourceId = typeof raw.sourceId === "string" ? raw.sourceId : undefined;
  return { bestParts: bp, followUps: fu, sourceId };
}

/** v1.7.5 — Read the optional `shortcut` attachment a message carries
 *  when it was produced by the client-side intent shortcut path. The
 *  ⚡ pill renders next to the message actions for transparency. */
function readShortcutAttachment(
  raw: ChatMessage["attachment"]
): { patternId: string; confidence: number } | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.mode !== "shortcut") return null;
  const patternId = typeof raw.patternId === "string" ? raw.patternId : null;
  const confidence =
    typeof raw.confidence === "number" ? raw.confidence : null;
  if (!patternId || confidence == null) return null;
  return { patternId, confidence };
}

function MessageActions({
  copied,
  canRegenerate,
  feedback,
  onCopy,
  onRegenerate,
  onFeedback,
  shortcut
}: {
  copied: boolean;
  canRegenerate: boolean;
  feedback?: "up" | "down";
  onCopy: () => void;
  onRegenerate: () => void;
  onFeedback: (k: "up" | "down") => void;
  /** When set, render a small ⚡ pill indicating the message came
   *  from the client-side intent shortcut path. */
  shortcut?: { patternId: string; confidence: number } | null;
}) {
  return (
    <div className={styles.actionRow} aria-label="Message actions">
      {shortcut && (
        <span
          className={styles.shortcutPill}
          title={`Local shortcut: ${shortcut.patternId} (${(shortcut.confidence * 100).toFixed(0)}% confidence)`}
          aria-label="Resolved locally without an AI call"
        >
          <Zap size={10} strokeWidth={2.5} />
          Local
        </span>
      )}
      <button
        type="button"
        className={styles.actionBtn}
        onClick={onCopy}
        title={copied ? "Copied" : "Copy message"}
        aria-label={copied ? "Copied" : "Copy message"}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      {canRegenerate && (
        <button
          type="button"
          className={styles.actionBtn}
          onClick={onRegenerate}
          title="Regenerate"
          aria-label="Regenerate"
        >
          <RotateCcw size={12} />
        </button>
      )}
      <button
        type="button"
        className={`${styles.actionBtn} ${feedback === "up" ? styles.actionBtnActive : ""}`}
        onClick={() => onFeedback("up")}
        title="Helpful"
        aria-label="Mark helpful"
        aria-pressed={feedback === "up"}
      >
        <ThumbsUp size={12} />
      </button>
      <button
        type="button"
        className={`${styles.actionBtn} ${feedback === "down" ? styles.actionBtnActive : ""}`}
        onClick={() => onFeedback("down")}
        title="Not helpful"
        aria-label="Mark not helpful"
        aria-pressed={feedback === "down"}
      >
        <ThumbsDown size={12} />
      </button>
    </div>
  );
}

function InferredBadges({ fields }: { fields: InferredField[] }) {
  return (
    <div className={styles.inferred}>
      <div className={styles.inferredHeader}>
        <Sparkles size={11} />
        <span>I assumed</span>
      </div>
      <div className={styles.inferredList}>
        {fields.map((f, i) => (
          <span
            key={`${f.field}-${i}`}
            className={styles.inferredPill}
            title={f.reason}
          >
            <strong>{f.field}</strong>
            <span className={styles.inferredEq}> = </span>
            <span>{formatInferredValue(f.value)}</span>
          </span>
        ))}
      </div>
      <p className={styles.inferredHint}>
        Just tell me what you&rsquo;d like changed.
      </p>
    </div>
  );
}

function formatInferredValue(v: InferredField["value"]): string {
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "\u2026";
}

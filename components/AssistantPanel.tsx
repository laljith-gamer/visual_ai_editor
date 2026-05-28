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
  Wand2,
  Zap
} from "lucide-react";
import { useEditorStore } from "@/hooks/useEditorStore";
import { useShare } from "@/hooks/useShare";
import { CapabilityBadge } from "./CapabilityBadge";
import { QuickReplies } from "./QuickReplies";
import { PlanPreview } from "./PlanPreview";
import { logUser } from "@/lib/log/recorders";
import type { ChatMessage, ClarifyQuestion, InferredField } from "@/lib/types";
import styles from "./AssistantPanel.module.css";

interface Props {
  onSubmit: (text: string) => Promise<void>;
  onOpenClips: () => void;
  /** Confirm the pending plan and start the analysis pipeline. */
  onRunPlan: () => void;
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
 * Two new affordances:
 *   - Think / Fast mode toggle: a UI-only hint that adjusts the
 *     placeholder, button label, and "thinking" status copy. The
 *     backend isn't aware of it (deliberately — no API changes), so
 *     it's a perceptual nudge rather than a parameter.
 *   - Per-message action bar: Copy / Regenerate / Thumbs up / down.
 *     Copy uses the Clipboard API. Regenerate re-sends the most recent
 *     user turn through the existing onSubmit pipe. Thumbs feedback is
 *     logged to the activity stream via logUser.
 *
 * Image upload is intentionally absent — this panel is text-only.
 */

const STARTER_PROMPTS = [
  "Make a 30s vertical reel of the funniest bits",
  "60s YouTube short of the highlights",
  "Find the moment where ___",
  "Just give me the best parts"
];

type ChatMode = "think" | "fast";

export function AssistantPanel({
  onSubmit,
  onOpenClips,
  onRunPlan,
  isBusy
}: Props) {
  const messages = useEditorStore((s) => s.messages);
  const renderedBlob = useEditorStore((s) => s.renderedBlob);
  const inferred = useEditorStore((s) => s.inferred);
  const pendingClarify = useEditorStore((s) => s.pendingClarify);
  const pendingExecution = useEditorStore((s) => s.pendingExecution);
  const hasVideo = useEditorStore((s) => Boolean(s.videoBlob));
  const sessionId = useEditorStore((s) => s.sessionId);

  const [text, setText] = useState("");
  const [mode, setMode] = useState<ChatMode>("fast");
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
        payload: { text: trimmed, mode },
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

  const onlyOneAssistantMessage =
    messages.length === 1 && messages[0]?.role === "assistant";

  const placeholder = pendingClarify
    ? "Type a custom answer, or tap a suggestion above\u2026"
    : pendingExecution
      ? "Adjust the plan in plain English (e.g. \u201Cmake it 60s\u201D)\u2026"
      : mode === "think"
        ? "Describe in detail what you want\u2026"
        : "Ask me anything";

  const sendLabel = isBusy
    ? mode === "think"
      ? "Thinking\u2026"
      : "Working\u2026"
    : "Send";

  return (
    <aside className={`assistant ${styles.panel}`}>
      {/* ─── Compact header with mode toggle ──────────────────── */}
      <div className={styles.header}>
        <div className={styles.title}>
          <span className={styles.titleIcon} aria-hidden>
            <Sparkles size={14} />
          </span>
          <span className={styles.titleText}>Smart Chat</span>
        </div>
        <ModeSwitch mode={mode} onChange={setMode} />
        <CapabilityBadge />
      </div>

      {/* ─── Conversation scroller ────────────────────────────── */}
      <div ref={scrollRef} className={`${styles.messages} scroll-y`}>
        {messages.map((m, i) => {
          const isAssistant = m.role === "assistant";
          const isLast = i === messages.length - 1;
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
                {isAssistant && (
                  <MessageActions
                    copied={copiedId === m.id}
                    canRegenerate={isLast && !!lastUserText && !isBusy}
                    feedback={feedback[m.id]}
                    onCopy={() => handleCopy(m)}
                    onRegenerate={handleRegenerate}
                    onFeedback={(k) => handleFeedback(m, k)}
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
                <span className={styles.typingLabel}>
                  {mode === "think" ? "Thinking deeply\u2026" : "Working\u2026"}
                </span>
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

        {pendingClarify && (
          <QuickReplies
            questions={pendingClarify.questions}
            disabled={isBusy}
            onPick={(suggestion) => void send(suggestion, "quickreply")}
          />
        )}

        {onlyOneAssistantMessage && !pendingClarify && (
          <StarterSuggestions
            disabled={isBusy}
            requireVideo={!hasVideo}
            onPick={(s) => {
              if (!hasVideo) return;
              void send(s, "quickreply");
            }}
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

function ModeSwitch({
  mode,
  onChange
}: {
  mode: ChatMode;
  onChange: (m: ChatMode) => void;
}) {
  return (
    <div className={styles.modeSwitch} role="tablist" aria-label="Chat mode">
      <button
        type="button"
        role="tab"
        aria-selected={mode === "fast"}
        className={`${styles.modeBtn} ${mode === "fast" ? styles.modeBtnActive : ""}`}
        onClick={() => onChange("fast")}
        title="Quick replies, snappier feel"
      >
        <Zap size={11} strokeWidth={2.5} />
        Fast
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === "think"}
        className={`${styles.modeBtn} ${mode === "think" ? styles.modeBtnActive : ""}`}
        onClick={() => onChange("think")}
        title="More thoughtful, longer answers"
      >
        <Wand2 size={11} strokeWidth={2.5} />
        Think
      </button>
    </div>
  );
}

function MessageActions({
  copied,
  canRegenerate,
  feedback,
  onCopy,
  onRegenerate,
  onFeedback
}: {
  copied: boolean;
  canRegenerate: boolean;
  feedback?: "up" | "down";
  onCopy: () => void;
  onRegenerate: () => void;
  onFeedback: (k: "up" | "down") => void;
}) {
  return (
    <div className={styles.actionRow} aria-label="Message actions">
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
        Tap a chip above to reply, or just say what you want changed.
      </p>
    </div>
  );
}

function StarterSuggestions({
  onPick,
  disabled,
  requireVideo
}: {
  onPick: (s: string) => void;
  disabled?: boolean;
  requireVideo: boolean;
}) {
  return (
    <div className={styles.starter}>
      <p className={styles.starterHint}>
        {requireVideo
          ? "Upload a video on the left first, then try:"
          : "Try one of these:"}
      </p>
      <div className={styles.starterRow}>
        {STARTER_PROMPTS.map((p) => (
          <button
            key={p}
            type="button"
            className={styles.starterChip}
            onClick={() => onPick(p)}
            disabled={disabled || requireVideo}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

function formatInferredValue(v: ClarifyQuestion | InferredField["value"]): string {
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "\u2026";
}

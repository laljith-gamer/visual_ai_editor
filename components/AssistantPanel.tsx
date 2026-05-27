"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Film, Download, Sparkles } from "lucide-react";
import { useEditorStore } from "@/hooks/useEditorStore";
import { useShare } from "@/hooks/useShare";
import { CapabilityBadge } from "./CapabilityBadge";
import { QuickReplies } from "./QuickReplies";
import { logUser } from "@/lib/log/recorders";
import type { ClarifyQuestion, InferredField } from "@/lib/types";
import styles from "./AssistantPanel.module.css";

interface Props {
  onSubmit: (text: string) => Promise<void>;
  onOpenClips: () => void;
  isBusy: boolean;
}

const STARTER_PROMPTS = [
  "Make a 30s vertical reel of the funniest moments",
  "Find the most action-packed clip",
  "60s YouTube short of the highlights",
  "Find the part where ___"
];

export function AssistantPanel({ onSubmit, onOpenClips, isBusy }: Props) {
  const messages = useEditorStore((s) => s.messages);
  const renderedBlob = useEditorStore((s) => s.renderedBlob);
  const inferred = useEditorStore((s) => s.inferred);
  const pendingClarify = useEditorStore((s) => s.pendingClarify);
  const hasVideo = useEditorStore((s) => Boolean(s.videoBlob));
  const sessionId = useEditorStore((s) => s.sessionId);

  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const share = useShare();

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, pendingClarify]);

  async function send(value?: string, source: "typed" | "quickreply" = "typed") {
    const trimmed = (value ?? text).trim();
    if (!trimmed || isBusy) return;
    setText("");
    if (source === "quickreply") {
      logUser({
        sessionId,
        kind: "quickreply.picked",
        payload: { suggestion: trimmed },
        summary: `Picked suggestion: "${truncate(trimmed, 40)}"`
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

  const onlyOneAssistantMessage = messages.length === 1 && messages[0]?.role === "assistant";

  return (
    <aside className={`assistant ${styles.panel}`}>
      <div className={styles.header}>
        <div>
          <p className="eyebrow">AI editor</p>
          <h2 style={{ margin: 0 }}>Chat</h2>
        </div>
        <CapabilityBadge />
      </div>

      <div ref={scrollRef} className={`${styles.messages} scroll-y`}>
        {messages.map((m) => (
          <div
            key={m.id}
            className={`${styles.message} ${m.role === "user" ? styles.user : styles.assistant}`}
          >
            <div className={styles.bubble}>{m.content}</div>
          </div>
        ))}

        {/* Inferred-fields badges below the latest assistant bubble */}
        {inferred.length > 0 && !pendingClarify && (
          <InferredBadges fields={inferred} />
        )}

        {/* Clarify questions with quick-reply chips */}
        {pendingClarify && (
          <QuickReplies
            questions={pendingClarify.questions}
            disabled={isBusy}
            onPick={(suggestion) => void send(suggestion, "quickreply")}
          />
        )}

        {/* Empty-state starter chips when there's only the greeting */}
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

      <div className={styles.composer}>
        <textarea
          className="textarea"
          placeholder={
            pendingClarify
              ? "Type a custom answer, or tap a suggestion above…"
              : "Describe the short you want, or say \u201Cfind the part where…\u201D"
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          rows={3}
        />
        <button
          className="btn primary"
          onClick={() => void send()}
          disabled={isBusy || !text.trim()}
        >
          <Send size={14} /> {isBusy ? "Working\u2026" : "Run"}
        </button>
      </div>

      <div className={styles.actions}>
        <button className="btn" onClick={onOpenClips}>
          <Film size={14} /> Clips
        </button>
        <div className="spacer" />
        {renderedBlob && (
          <button
            className="btn"
            onClick={() =>
              void share({
                blob: renderedBlob,
                filename: "shorts-studio.mp4",
                title: "Shorts Studio export"
              })
            }
          >
            <Download size={14} /> Export Short
          </button>
        )}
      </div>
    </aside>
  );
}

function InferredBadges({ fields }: { fields: InferredField[] }) {
  return (
    <div className={styles.inferred}>
      <div className={styles.inferredHeader}>
        <Sparkles size={11} />
        <span>I assumed:</span>
      </div>
      <div className={styles.inferredList}>
        {fields.map((f, i) => (
          <span
            key={`${f.field}-${i}`}
            className={`pill ${styles.inferredPill}`}
            title={f.reason}
          >
            <strong>{f.field}</strong>
            <span className="faint"> = </span>
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
          ? "Upload a video on the left first, then try one of these:"
          : "Try one of these:"}
      </p>
      <div className={styles.starterRow}>
        {STARTER_PROMPTS.map((p) => (
          <button
            key={p}
            type="button"
            className={`btn ${styles.starterChip}`}
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
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
